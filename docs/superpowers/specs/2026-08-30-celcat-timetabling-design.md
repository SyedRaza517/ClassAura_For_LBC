# CELCAT-style timetabling — design

**Date:** 30 August 2026
**Status:** approved, awaiting implementation plan
**Scope decision:** a self-contained module. It adds tables and files; it does not modify
`HndSession`, `AttendanceMark`, `TimetableSlot`, the register generator, or the prediction
pipeline.

---

## What was asked for, and what was researched first

The request was to reproduce CELCAT — the timetabling product the reference screenshots
come from — so that a member of staff can see their own timetable on the web and in the
phone app, with an admin dashboard behind it where the college configures what staff see.

The screenshots are **University of Westminster's** CELCAT Calendar (the room list reads
`101 - First floor [Great Titchfield Street]` and `101 [Harrow]`, both Westminster
campuses). Research was done before any design, against the vendor's own pages and three
universities' user guides, and it produced one finding that changed the shape of the
build. That finding is §2.

### CELCAT is two products

- **CELCAT Timetabler** — the planner. A human builds the schedule, assigns rooms and
  staff, resolves clashes.
- **CELCAT Calendar** — the read-only viewer in the screenshots. Imperial's help sheet is
  explicit that it "provides read-only access to timetable data that is held in the Celcat
  database."

The request covers both halves: the Calendar is what staff see, the dashboard is the
Timetabler. Building only the viewer would leave nothing to view, because — see §2 —
the data it would read does not exist.

### What CELCAT Calendar actually consists of

Taken from the fourteen reference screenshots and cross-checked against the guides:

| Element | Detail |
|---|---|
| Timetable types | Exactly five, in one "Choose Timetable Type" dropdown: **Module Offerings** (733), **Rooms** (116), **Teaching Staff** (816), **Students** (9009), **Groups** (785) |
| Selection | "Select timetables" modal — pick type, search, `Result (n)` list with ⊕, `Selected (n)` list, `Reset` / `Apply` |
| "My Resources" | A checkbox that "will automatically determine which resources are relevant for the user". **This is CELCAT's whole answer to "my timetable" — there is no separate personal screen** |
| Views | Day, Week, Month, Timeline; plus a grid-vs-list toggle |
| Navigation | `Today` `«` `‹` *range* `›` `»`, and a mini month picker with today ringed |
| Notice banner | Free institutional text across the top (Westminster's carries SLC attendance wording), dismissible via a ⋮ menu |
| Colour key | Colour is a **chosen dimension**, not a fixed palette: Module Offering, Room, Group, Course Offering, Event Category |
| My Settings | Three tabs — *Calendar view* (show availability, swap grid axes, per-period and per-day checkboxes), *Events* (local time zone + picker, colour key, Normal/Light variant), *Annotations* (show event times, show Event ID, highlight recently changed + max days ago, and a reorderable list of what prints inside a tile: Event name, Module Offering, Event Category, Room, Teaching Staff, Group, Department) |
| Beyond the screenshots | iCal subscription feeds and change notifications when a room or time moves |

---

## 2. The finding: we cannot express a manually assigned timetable

The instruction was that the timetable is **set manually**, as in CELCAT — an admin places
an event and assigns it a room, staff and groups. That is precisely the thing this schema
cannot currently record.

| CELCAT concept | What exists here | Status |
|---|---|---|
| Teaching Staff | `Staff` | ✅ |
| Students | `Student` | ✅ |
| Groups | `Cohort` | ✅ |
| Module Offerings | `Unit` | ✅ |
| Course Offerings | `Course` | ✅ |
| **Rooms** | `TimetableSlot.room` — a free-text string | ❌ no model, no floor, campus, capacity or type |
| **Event → staff** | `TimetableSlot.lecturer` — free text. Only `Unit.tutorStaffId` is a relation, and it is per-unit, not per-session | ❌ **the blocker** |
| **Event categories** | `HndSession.kind` — free string | ❌ no model |
| **Periods** | a hardcoded four-block ladder in the register generator | ❌ no model |
| Notice banner | — | ❌ |
| Clash detection | — | ❌ (`AUTO-TIMETABLING.md` §1.3) |

The consequence is worth stating plainly, because a screen can be built that hides it. If
"my timetable" is answered by matching `TimetableSlot.lecturer` against a staff member's
name, then two lecturers who share a surname see each other's classes, a lecturer recorded
as "S. Raza" on one row and "Syed Raza" on another sees half their week, and **nothing
anywhere reports that this happened**. A timetable that is quietly wrong is worse than no
timetable, because staff plan around it.

So the centre of gravity of this build is an **event model with real relations**. The grid,
the tab and the settings dashboard are the easy half.

### Rejected: build the grid over what exists

Considered and rejected. It reaches something that looks like the screenshots fastest, and
every hour of it is thrown away when the relations land — plus it ships the name-matching
failure above to real staff in the meantime.

### Rejected: extend `HndSession` into the event

One row and one truth is genuinely attractive: a timetable and a register that cannot
disagree. It was rejected on `unitId`, which is `NOT NULL` and which the entire attendance
pipeline assumes. CELCAT events include exams, workshops, study support and meetings that
belong to no module; representing them would mean making `unitId` nullable, and that
migration reaches attendance, banding and prediction — the highest-consequence code in the
repo — for a feature that has not shipped yet.

### Chosen: a new event model, with a documented seam to registers

`TimetableEvent` owns the schedule. A register (`HndSession`) will later carry a
`timetableEventId` FK back to the event it came from, so that moving an event moves its
register, with no name matching anywhere. **That FK is not built in this pass** — see §8.

---

## 3. Data model

Seven new tables. All tenant-scoped, and therefore isolated automatically by `db.js` without
the routes doing anything (`CLAUDE.md`, "Tenant isolation is central").

### `Room`

`name`, `floor`, `campus`, `capacity`, `kind`, `active`. The screenshot's
`101 - First floor [Great Titchfield Street]` decomposes exactly into name + floor +
campus, which is why all three are columns rather than one label.

`capacity` is **nullable**, and deliberately: null means "we have not recorded how many
this room seats", which is not the same as zero. Zero would make the room unusable by any
future capacity check; null makes it unchecked. This is the null-is-not-zero convention the
academic code already runs on.

Unique on `(tenantId, name, campus)` — two campuses may both have a room 101, and the
screenshots show exactly that (`101 [Harrow]` and `101 - First floor [Great Titchfield
Street]`).

### `EventCategory`

`name`, `colour`, `active`. CELCAT's Event Category, which here is currently the free
string `HndSession.kind` ("Teaching", "Seminar"). A table because the colour key colours
by it, and a colour needs somewhere to live.

### `TimetableEvent`

The core.

- `date` (`YYYY-MM-DD`), `startTime`, `endTime` (`HH:MM`) — **strings**, compared as
  strings, per the house convention. `src/clock.js` supplies "today"; the host clock is
  never used for a user-facing date.
- `title`, `notes`
- `roomId?`, `categoryId?`, `unitId?` (Module Offering), `courseId?` (Course Offering)
- `published` — draft events are invisible to staff, exactly as `TimetableSlot.published`
  already governs the student timetable
- `changedAt` — set on every write that moves the event in time or space. This is what
  backs "Highlight recently changed events / Maximum days ago", and it must be a
  **timestamp**, not a day count: a day passing is not an event, so a stored "changed 3
  days ago" is wrong by the next morning with nothing to correct it. Columns hold
  timestamps; the screen subtracts.

**`unitId` is nullable, and that nullability is the point.** It is what lets an exam, a
workshop, a study-support session or a staff meeting exist as a timetabled event — the
thing `HndSession` structurally cannot represent, and the reason a new table exists at all.

Indexed on `(tenantId, date)` — every read is a date-window read.

### `TimetableEventStaff` — `(eventId, staffId)`, unique

CELCAT allows several staff on one event (a lecture with a demonstrator). More importantly
this join is **the relation that makes "my timetable" a query rather than a name match**,
which is the whole finding of §2.

### `TimetableEventGroup` — `(eventId, cohortId)`, unique

### `TimetableSettings` and `TimetableUserPref`

One row per tenant, one row per staff member, each holding a JSON blob of display
preferences.

This follows the established per-tenant configuration pattern (`attendanceBandConfig.js`,
`prediction/settings.js` are the reference implementations) with **one layer added**:

> platform defaults in code → tenant JSON merged over them → **user JSON merged over that**
> → allowlist on the way out → short cache invalidated on save

The third layer exists because CELCAT's My Settings is per-person, and because these staff
use both the web and the phone app — `localStorage` would mean a lecturer's chosen periods
and hidden weekend follow them on one device and not the other. No row is written until
somebody edits something.

The tenant blob additionally carries the **notice banner** text and its on/off switch.

### Not built: `TimetableEventStudent`

A student's timetable derives from `Student.cohortId` plus their `Enrolment` rows. A third
join table would earn its keep only for one-to-one tutorials naming an individual student,
which nothing has asked for. Left out until something needs it.

---

## 4. Server

Two routers, mounted below `tenantMiddleware` like everything that is not platform or
registration.

### `/api/timetabling` — admin, `requirePage("scheduling")`

- Rooms: list / create / update / delete
- Categories: list / create / update / delete
- Events: list by date window with filters, create, update, delete
- **Weekly repeat**: expand one event across a date range. Hand-entering twelve weeks of a
  Tuesday lecture is not a feature, it is a reason the tool goes unused.
- Publish / unpublish across a date range
- Settings: read and write the college-wide display defaults and the notice banner

### Clash detection

Now possible for the first time, because the relations are real. `AUTO-TIMETABLING.md` §1.3
records the current position: nothing anywhere checks for a clash, so "a tutor can be given
two rooms at 18:00 on a Tuesday and the system will save it, publish it, and show it to
students on both courses."

Create and update return warnings wherever the assigned **room**, any assigned **staff
member**, or any assigned **group** already holds an overlapping event on that date.

It is a **warning, not a block.** A college has legitimate reasons to overlap — a room
split between two half-groups, a lecturer nominally on two registers — and a hard refusal
would be worked around by entering the event with the room left blank, which loses the
information entirely. A visible warning that is overridden is a record; a refusal is a
data-entry workaround.

### `/api/my-timetable` — any signed-in staff member, `requireAuth` only

No page gate. Every lecturer reads their own timetable; gating it on an admin page would
mean granting an admin page to the entire teaching staff.

- `GET /resources?type=&q=` — backs the "Select timetables" picker across all five types.
  Returns display label and id, nothing else. Paged: the reference institution has 9,009
  students and 816 staff.
- `GET /?from=&to=&type=&ids=` — **published** events in a date window, defaulting to *my*
  events (CELCAT's "My Resources").
- `GET` / `PUT /settings` — My Settings.

All five types are searchable by any signed-in staff member, matching CELCAT, which was an
explicit decision: it means an ordinary lecturer can look up a named student's weekly
whereabouts. That is a larger disclosure than anything else in the staff app today and is
recorded here as a decision taken knowingly, not an oversight.

Serialisation goes through **allowlists, never blocklists** — `sAdmission` is the standing
example of what the other way costs.

---

## 5. Client

Two new files. `StaffHub.jsx` is 14,359 lines with no test framework behind it, and there
is precedent for keeping admin pages out of it (`AdminLiveAttendance.jsx`,
`AdminNfcTags.jsx`).

### `client/src/TimetableCalendar.jsx` — the viewer, shared by both surfaces

Day / Week / Month / Timeline, the grid-vs-list toggle, the mini month picker, `Today « ‹ ›
»`, the notice banner, the event colour key, the event detail panel, and the My Settings
modal with its three tabs as inventoried in §1.

**On a handset the Week view defaults to List.** A seven-column hour grid at 390px is
unreadable, and CELCAT's own mobile presentation does the same. `useIsHandset()` already
exists in `PhoneShell.jsx` and makes the decision.

### `client/src/AdminTimetablePlanner.jsx` — the dashboard

Rooms and categories management; the event editor with **manual assignment from real
dropdowns** — room, staff, groups, module — which is the requested behaviour and the thing
§2 makes possible; clash warnings inline; publish; and the college-wide display defaults.

### The staff tile

`TILES` gains **"My Timetable"** and the screen router gains one line, both in
`StaffHub.jsx` — roughly fifteen lines, rendering `TimetableCalendar`. Because `StaffApp`
already runs through `PhoneShell` on desktop and handset alike, **that single screen is
both "on the web" and "in the app"**; there is no second implementation.

### `ADMIN_PAGES`

`"scheduling"` is added to **both** hand-maintained copies — `server/src/validate.js` and
`client/src/StaffHub.jsx` — with the label "Scheduling". The name avoids collision with the
existing "Timetable" page, which remains untouched and keeps serving the student timetable.

---

## 6. Testing

Following the existing split: pure logic in its own files with tests beside it and no
database; everything else through HTTP smoke suites.

**Unit-tested, no database:**

- `overlap.js` — do two `HH:MM` ranges on a date collide
- `recurrence.js` — weekly expansion across a range
- `settingsMerge.js` — the three-layer merge and its outbound allowlist

**`scripts/smoke-timetabling.mjs`**, weighted toward negative assertions as the other
suites are:

- an ordinary lecturer cannot see an unpublished event
- a staff token is refused by `/api/timetabling`
- one tenant cannot see another tenant's rooms
- the clash check fires on a genuine double-booking
- a settings `PUT` carrying an unknown key drops it rather than storing it
- a room deleted while events reference it does not orphan them

Every regression test will be proved able to fail — the bug reintroduced, the test seen to
catch it — before it counts as coverage. Two tests in recent work passed while
discriminating nothing.

The client has no test framework; it is verified by building, per `CLAUDE.md`.

---

## 7. Migration and database safety

One forward-only migration. It is **additive only** — seven new tables, no column altered on
any existing table — so it cannot affect attendance, banding or prediction.

Development and testing run against the local database, never `server/.env`:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-timetabling
```

The migration directory name is final once applied anywhere. Renaming it is what produced
P3009 twice.

---

## 8. Out of scope for this pass

Recorded so the next reader knows these were decided rather than forgotten:

- **`HndSession.timetableEventId`** — the seam to registers. Designed for (§2), not built.
  Until it exists, a timetabled event and its register are two separate records and can
  drift; that is accepted for this pass because the module is standalone by instruction.
- **Automatic scheduling.** `AUTO-TIMETABLING.md` and `AUTO-TIMETABLING-SOLVER.md` cover it.
  Note that the models in §3 are the data those documents say does not exist yet, so this
  build is the prerequisite for that one.
- **iCal subscription feeds** and **change notifications**, both of which real CELCAT has.
- **Room availability search** ("find me a free room for 30 at 2pm"). The `Room` table makes
  it possible; it is not in this pass.
- Any change to the existing Timetable admin page or the student timetable.
