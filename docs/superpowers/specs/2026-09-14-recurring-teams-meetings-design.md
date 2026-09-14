# Recurring Teams class meetings — design

**Status:** draft for review · 14 Sep 2026
**Supersedes part of:** `2026-09-11-teams-auto-attendance-design.md` and
`2026-09-12-teams-automation-design.md` (the meetings half of Phase A).

## Goal

One **recurring** Microsoft Teams meeting per class series — a single join link that
covers every weekly occurrence from the class's first date to its last — created
automatically when a recurring class is published, with the teaching staff as
**co-organizers** and the one scheduling account as the sole organizer. The link must
appear on the **timetable**, in the **student app**, and in the **Teams app**. Changes to
the class (lecturer, title, time, the date range) update that one meeting.

This replaces today's behaviour, where the automation creates **one separate meeting per
weekly occurrence** (`teamsMeetings.js` iterates `TimetableEvent` rows one at a time).

## Decisions locked with the college (14 Sep 2026)

1. **Meeting span = the class's real dates.** The recurring meeting runs from the series'
   first occurrence to its last (`seriesDates`' output already gives both). `Unit.startDate`
   / `Unit.endDate` may pre-fill the entry form, but the meeting's range is the series it
   actually produced, so the meeting can never out-run or under-run the real lessons.
2. **v1 = whole-series edits.** Changing or cancelling the whole class is handled cleanly.
   Moving or cancelling a **single week** (a Graph recurrence *exception*) is explicitly a
   later phase — see Non-goals.
3. **Real co-organizers.** The teacher(s) are set as Teams co-organizers, which needs a new
   Graph permission (`OnlineMeetings.ReadWrite.All`) and one more admin consent.
4. **Standard cohort channel.** "Students in the class channel" means the unit's standard
   channel under the cohort Team — already produced by `teamsProvisioning.js`. No private
   channel per class in this work.

## Current state (what this changes and why the change is load-bearing)

- **`POST /events`** (`timetabling.js:1314`) turns a recurring class into **N**
  `TimetableEvent` rows — one per (date × session block) — all sharing one `seriesId`
  (`timetabling.js:1405`, `1416-1428`). A single event has **no** `seriesId`.
- **`teamsMeetings.js`** reconciles **per event**: each row with `published && teamsAutoMeeting`
  and no owned meeting gets its **own** `createClassMeeting` call and its **own** join URL.
- **Attendance collection has a merge that makes a shared link unsafe.**
  `teamsGraph.attendanceIntervals(organizerId, meetingId)` (`teamsGraph.js:290-319`) fetches
  a meeting's `attendanceReports` **list** — Microsoft returns **one report per occurrence
  held** — and **flattens every report's records into one per-person interval set, keyed only
  by person, discarding which report/date each came from** (its own docstring, `teamsGraph.js:289`).
  Per-date attendance works today **only** because each week currently has a **distinct**
  meeting id. Reuse one recurring meeting id across twelve weeks and a student present in
  *any* week is clipped-in for *every* week's register. **Rewriting this is mandatory for
  correctness, not optional.**

## The design

### A. Where the recurring meeting lives — a new `TeamsSeriesMeeting` table, keyed by `seriesId`

A recurring meeting belongs to the *series*, not to any one occurrence, so it gets its own
row rather than being stored on an arbitrary "first" event:

```prisma
model TeamsSeriesMeeting {
  id                String   @id @default(cuid())
  seriesId          String   @unique          // the TimetableEvent.seriesId this covers
  calendarEventId   String                    // the recurring Graph event (the series master)
  joinUrl           String
  meetingId         String?                   // resolved onlineMeeting id, for co-organizer + attendance
  organizerId       String                    // the creator account's Entra id
  fingerprint       String                    // subject|firstDate|lastDate|weekdays|start|end|sorted(staff)
  coorganizersSetAt DateTime?                 // when co-organizer roles were last written
  lastSyncedAt      DateTime @default(now())
  createdAt         DateTime @default(now())
}
```

Rationale for a table over reusing the per-event columns: the existing
`TimetableEvent.teamsCalendarEventId` / `teamsMeetingFingerprint` columns are per-row and
their fingerprint is per-occurrence; a series meeting is one object reconciled against the
*whole* series, so it needs one row and a series-level fingerprint. One-off events (no
`seriesId`) keep using the existing per-event path unchanged.

The join URL is still **copied onto every occurrence** — `TimetableEvent.teamsJoinUrl` (for
the timetable) and `HndSession.teamsJoinUrl` (for the student app and attendance) — so the
three surfaces read exactly as they do today. `HndSession.teamsMeetingId` /
`teamsOrganizerId` are also filled from the series meeting, so collection needs no discovery
round-trip.

### B. Meetings sync rework — reconcile per series, keep per-event for one-offs

`teamsMeetings.runMeetingsSync` gains a **series pass** ahead of its existing per-event pass:

1. Group the reconcile-window events by `seriesId` (non-null). For each series whose events
   are `published && teamsAutoMeeting`:
   - **first date** = min occurrence date, **last date** = max, **weekdays** = the distinct
     ISO weekdays present, **start/end time** = the series' session time(s).
   - **subject** = event title (unit name/code fallback), same as today.
   - **attendees** = teaching staff + the unit channel email (as today), but staff are also
     recorded for the **co-organizer** write in step D.
   - Compute the series `fingerprint`. If no `TeamsSeriesMeeting` row: **create** the
     recurring meeting (C), store the row, fan the link out to all occurrences. If the row
     exists and the fingerprint changed: **update** the recurring meeting and re-fan. If the
     series is no longer wanted (unpublished / checkbox cleared): **cancel** and clear.
2. The existing **per-event** pass runs only for events with **no `seriesId`** (genuine
   one-offs), unchanged.

This keeps the whole thing idempotent and additive in the same way the current engine is;
the fingerprint gate stops the hourly tick re-PATCHing (and re-notifying) an unchanged
series, exactly as `meetingFingerprint` does today.

### C. Graph: recurring event + co-organizer writes (`teamsGraph.js`)

- **`createRecurringClassMeeting({ organizerId, subject, firstDate, lastDate, weekdays, startTime, endTime, attendeeEmails })`** —
  same `POST /users/{organizerId}/events` as `createClassMeeting`, plus a `recurrence`:
  ```jsonc
  "recurrence": {
    "pattern": { "type": "weekly", "interval": 1, "daysOfWeek": ["monday", ...] },
    "range":   { "type": "endDate", "startDate": "<firstDate>", "endDate": "<lastDate>" }
  }
  ```
  Returns `{ calendarEventId, joinUrl }`. `start`/`end` carry the **first** occurrence's
  wall-clock time; the pattern repeats it.
- **`updateRecurringClassMeeting(...)`** — PATCH the series master event (subject, times,
  attendees, recurrence range).
- **`setMeetingCoorganizers({ organizerId, meetingId, coorganizerUserIds })`** — resolve the
  `onlineMeeting` id from the join URL (existing `resolveMeetingId`), then
  `PATCH /users/{organizerId}/onlineMeetings/{meetingId}` with
  `participants.attendees[].role = "coOrganizer"`. Needs `OnlineMeetings.ReadWrite.All`.
  Idempotent; `coorganizersSetAt` records the last successful write so an unchanged staff set
  is not re-written every tick.
- All four keep the fixtures-first shape (`journal(...)` + fixed ids) so the smoke suite runs
  with no tenant.

### D. Attendance collection rewrite — keep each report's own date (`teamsGraph.js` + `teamsSync.js`)

Replace the merge with a **per-report** shape:

- New/!reworked **`attendanceIntervalsByOccurrence(organizerId, meetingId)`** returns a list
  of `{ date, intervals: [{ email, msUserId, joinedAt, leftAt }] }`, one entry per
  attendance report, using the report's own **`meetingStartDateTime`** (→ local `date` via
  `clock.js`) instead of collapsing them. (Confirm the exact field name against a live report
  during implementation; `meetingStartDateTime` is the documented attendanceReport field.)
- `teamsSync.js` collection: for each eligible `HndSession`, fetch the occurrence list once
  per **meeting id** (memoised across that meeting's sessions in the run, so a 12-week series
  is one Graph fetch, not twelve), then apply **only the occurrence whose `date` equals the
  session's `date`** — window-clipping by `startTime/endTime` stays as the within-day guard.
  A session with no matching occurrence report writes **no marks** (same as a failed fetch
  today) and stays eligible inside the 7-day retry window.

This is the highest-risk change and gets its own tests: a fixture recurring meeting with
reports on three dates must mark each date's register from **its own** report only.

### E. Provisioning & the three surfaces — mostly already done

- **Student channel membership**: unchanged — `teamsProvisioning.js` already adds the cohort
  as Team members (standard channel access) and staff as owners.
- **Timetable**: `TimetableEvent.teamsJoinUrl` is set per occurrence from the series meeting.
- **Student app**: `HndSession.teamsJoinUrl` drives the Check-In screen, as today.
- **Teams app**: the recurring meeting appears on the organizer's, co-organizers' and
  attendees' calendars natively; the channel-email invite (existing `channelEmailsFor`) drops
  it into the unit channel.

### F. Updates that must propagate

Editing an event already bumps `updatedAt` and (for series edits) rewrites occurrences. The
series fingerprint (subject, first/last date, weekdays, times, sorted staff) is what the sync
compares: change the **lecturer** → staff set changes → co-organizers re-written + attendees
PATCHed; change **title/time** → meeting PATCHed; **shorten/extend** the class → recurrence
range PATCHed; **withdraw** the class → meeting cancelled and links cleared from every
occurrence and register (reusing today's cancel-and-null path).

## Setup / permissions change

`TEAMS_SETUP.md` gains: **`OnlineMeetings.ReadWrite.All`** (Application) added to the same app
registration and admin-consented, replacing the read-only `OnlineMeetings.Read.All` (write
implies read for what attendance needs). It is still scoped to the organizer accounts by the
**existing** Teams application access policy (Step 7) — a policy scopes an app to *mailboxes*,
not to a permission, so no policy change is needed, the same way the Exchange policy already
covers the `Calendars.Read → ReadWrite` upgrade.

## Non-goals (explicitly out of scope for v1)

- **Single-week exceptions** — moving or cancelling one occurrence of a running series
  (Graph recurrence exceptions). v1 recommends editing the whole series; a moved single
  occurrence may fall out of the recurring meeting until per-occurrence exceptions ship.
- **Private per-class channels** — standard cohort channels only.
- **Non-weekly patterns** — the entry form produces weekly-by-weekday series; fortnightly or
  monthly patterns are not modelled.

## Risks & testing

- **Attendance correctness (highest).** Unit tests on the report→date mapping; a smoke test
  that a recurring meeting with reports on distinct dates marks each register from its own
  report and never cross-contaminates weeks.
- **Co-organizer permission propagation.** Test connection should name it if missing, the
  same way it names other missing consents.
- **Fingerprint churn.** Verify an unchanged series does not re-PATCH or re-notify on the
  hourly tick (the bug the per-event fingerprint already fixed once).
- **Mixed series/one-off** in one window: a one-off event with no `seriesId` still uses the
  per-event path and is untouched by the series pass.

## Rollout

Ships behind the **existing** "Auto-create meetings" switch (off by default). A college
already using per-occurrence meetings: on first run after deploy, series with existing
per-event meetings need a defined migration path — **either** leave existing per-event
meetings alone and only apply recurring meetings to newly-published series, **or** a one-time
reconcile that cancels per-event meetings and replaces them with one recurring meeting per
series. Recommend the former (less disruptive; no mass re-notification) — to confirm at plan
time.
