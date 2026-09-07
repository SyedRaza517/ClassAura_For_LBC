# Timetabling → Registers: one timetable, three surfaces

**Date:** 7 September 2026
**Status:** approved in conversation; awaiting spec review
**Supersedes in part:** `2026-08-30-celcat-timetabling-design.md`, which built the
planner and the staff view. That document stands; this one extends it to students, to
the register, and to a manual entry form the earlier design did not have.

---

## 1. What this is for

An administrator enters a class once — module, lecturer, group, room, campus, time,
start and end date — and that single entry feeds three things:

1. **A register dashboard** where staff mark students, filtered by name, student ID,
   campus, time and group.
2. **The student app**, where a student sees their class and checks in.
3. **A calendar**, CELCAT-shaped, where clicking a day shows everything on it.

The point is not the calendar. The point is that all three read one row, so they
cannot disagree with each other.

---

## 2. The problem, stated honestly

The platform currently holds **three separate timetables that do not know about each
other**, and a register that knows about none of them.

| # | Model | Read by | Lecturer / room held as |
|---|---|---|---|
| 1 | `TimetableSlot` + `TermCalendar` | Students, via `/api/student/me/timetable` | **Free-text strings** |
| 2 | `TimetableEvent` + `Room` + joins | Staff only, via `/api/my-timetable` | **Real foreign keys** |
| 3 | `HndSession` | The attendance register | Neither — no room, no lecturer |

So today an admin builds a timetable in **Scheduling**, a lecturer sees it in **My
Timetable**, and a student opens the portal and sees **a different timetable** built on
a different screen where the lecturer's name was typed by hand.

The register is worse. `routes/hnd.js` generates registers from hardcoded blocks:

```js
const BLOCKS = [["10:00","13:00"], ["14:00","17:00"], ["17:00","20:00"], ["20:00","23:00"]];
```

It steps weekly from the unit's start date and **invents the times**. If the timetable
says Tuesday 09:00–15:00 in Room 204, the register still says 10:00–13:00, in no room,
and nothing reports the discrepancy because nothing is comparing them.

This is why the work is not "add a calendar". It is **making one of the three the
truth and retiring the other two**.

---

## 3. What the competition does, and what we took from it

Full sources at the end. The findings that changed this design:

**CELCAT's architecture, from St Mary's University's own staff manual:**

> "The Timetable (in CELCAT) gives the definitive list for each session of who should
> be where and when."

The register is downstream of the timetable. Card taps are matched against session
details and become Present / Absent / Late, with *"no staff intervention required —
other than to deal with exceptions"*. That is the design adopted here.

**Five specific findings:**

1. **Non-attendance is left blank, not marked absent.** *"Students who did not tap
   will not be marked Absent immediately — (blank). Blanks are turned Absents 25 hours
   from the end of the session."* This is the null-is-not-measurable rule this codebase
   already runs on, arrived at independently. It justifies §7.4.
2. **Their latency is 5–10 minutes and sometimes 40+.** Ours writes the mark inside the
   request. Worth knowing we are ahead, and worth not regressing.
3. **Four mark codes: `/` Present, `L` Late, `A` Absent, `N` Not required.** We keep
   P/L/E/A unchanged — see §12.
4. **Three routes to a register: My Timetable, My Registers, Modules**, where *My
   Registers* is a dashboard of today's, overdue and upcoming. We had only the first.
5. **Register groups.** When a cohort is too large for a room CELCAT splits it and
   manages several registers for one scheduled activity. This is the industry answer to
   merged classes and it matches the decision taken in §4.

**Qwickly** uses a QR that *"changes every few seconds to ensure the student is in the
room"*, plus NFC tags at the entrance or per seat. Our rotating signed code is the same
mechanism, independently arrived at — which is a reason to route the new Check In
button *through* it rather than around it.

**SEAtS**, the closest competitor, flags a regulatory change: **from April 2026 a class
register alone no longer satisfies UKVI sponsor duties**; institutions must evidence
academic engagement across physical *and* digital environments. The prediction engine,
VLE engagement signals and tripwires already produce that evidence. This feature is
what ties it to a scheduled session.

**Universal across every product surveyed: calendar subscription** (iCal / M365 /
Google). It is table stakes, not a differentiator. Still out of scope for v1 (§13), but
it should be the first thing built afterwards.

---

## 4. Decisions taken

Each was put to the product owner and answered. They are recorded here because the
reasoning is not recoverable from the code.

| # | Decision | Chosen |
|---|---|---|
| D1 | Timetable ↔ register | **The event creates the register.** Not a manual sync, not a display-only link. |
| D2 | Audience | **Staff and students.** Applicants excluded. |
| D3 | The old `TimetableSlot` timetable | **Migrate, then retire.** |
| D4 | Clashes | **Warn clearly, allow anyway.** |
| D5 | The app's Check In button | **Opens the scanner for that class.** It does not mark presence directly. |
| D6 | Merged classes | **Separate registers per group.** |
| D7 | Recurrence | **Several weekdays selectable in one entry.** |
| D8 | Register roster | **Cohort members enrolled on the module**, falling back to the whole cohort when the unit has no enrolment data at all. |
| D9 | Campus | **A managed list**, not free text. |
| D10 | Time entry | **Presets plus custom**, presets held in settings. |
| D11 | Mark codes | **Unchanged.** No fifth code. |

**On D5.** The check-in system is proof-of-presence: an HMAC-signed QR that rotates on
a timer, or a registered NFC sticker on the wall of the room. A button that wrote a
mark directly would let a student check in from home and would reduce the rotating
codes, the stickers and the tap log to decoration. The button is a *shortcut into* that
flow — it opens the scanner already aimed at the right class — not a way round it.

---

## 5. Architecture

```
                       ┌────────────────────────┐
   Admin ─── writes ──▶│     TimetableEvent     │
   (Scheduling)        │  seriesId, date, times │
                       │  unit · staff · groups │
                       │  room → campus         │
                       └───────────┬────────────┘
                                   │ published + createRegisters
                                   ▼
                       ┌────────────────────────┐
                       │  HndSession (register) │  one per event × group
                       │  + timetableEventId    │
                       │  + cohortId · roomId   │
                       └───────────┬────────────┘
                                   │
        ┌──────────────────┬───────┴────────┬───────────────────┐
        ▼                  ▼                ▼                   ▼
  Register dashboard   Staff calendar   Student portal     Student app
  (mark, filter)       (My Timetable)   (web timetable)    (Check In)
                                                                │
                                                        scan / tap ──▶ AttendanceMark
```

One writer, four readers. No screen computes a timetable of its own.

---

## 6. Data model

### 6.1 New: `Campus`

```prisma
model Campus {
  id        String   @id @default(cuid())
  name      String   @unique
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  rooms     Room[]
}
```

`Room.campus` is free text today, so "Ealing", "ealing" and "Ealing Campus" are three
campuses to any filter built on it. The migration creates one `Campus` per distinct
non-empty trimmed value, case-insensitively, and points each room at it.

`Room` gains `campusId String?` and its `@@unique([name, campus])` becomes
`@@unique([name, campusId])`. **`Room.campus` is kept, not dropped**, for one release:
it is the only record of what the string was if the match turns out wrong, and dropping
it in the same migration that consumes it leaves nothing to check against.

### 6.2 `TimetableEvent` gains

| Field | Purpose |
|---|---|
| `seriesId String?` | Groups the occurrences one form submission created. Without it "cancel this class for the rest of term" is not expressible. Indexed. |
| `createRegisters Boolean @default(true)` | The admin's per-series answer to "should this produce registers". |
| `publishedAt DateTime?` | Distinguishes never-published from published-then-withdrawn. Register creation triggers on the transition, so it needs the difference. |

### 6.3 `HndSession` gains

| Field | Purpose |
|---|---|
| `timetableEventId String?` | The link. Nullable: registers from the Moodle import and the legacy generator have none. |
| `cohortId String?` | **Which group this register is for.** D6 lives here. |
| `roomId String?` | Where the class is — the field the student app is missing. |

### 6.4 The uniqueness rewrite

`HndSession` currently carries `@@unique([unitId, date, startTime])`. Its comment
records why: without it a second generate run *"silently doubled every attendance
denominator"*. That guarantee must survive.

But D6 requires two registers for one module at one time — that is precisely what a
merged class with separate group registers *is*. So the constraint is replaced by two
**partial** indexes, raw SQL in the migration:

```sql
-- Legacy and Moodle-imported registers keep the original guarantee, unchanged.
CREATE UNIQUE INDEX "HndSession_generated_key"
  ON "HndSession" ("unitId", "date", "startTime")
  WHERE "timetableEventId" IS NULL;

-- Timetable-created registers are identified by their event and group instead.
-- COALESCE, not a plain two-column index: Postgres treats NULLs as distinct, so an
-- event with no cohort would otherwise accept unlimited duplicate registers — the
-- exact hole the original constraint existed to close.
CREATE UNIQUE INDEX "HndSession_event_group_key"
  ON "HndSession" ("timetableEventId", COALESCE("cohortId", ''))
  WHERE "timetableEventId" IS NOT NULL;
```

**Prisma cannot express a partial unique index**, so these are invisible to
`schema.prisma`. Two consequences, both handled rather than hoped about:

- The `@@unique([unitId, date, startTime])` line is removed from the model and replaced
  by a comment naming both indexes and this section.
- `schema-contract.test.js` — which already parses `schema.prisma` as text — gains an
  assertion that the comment is present and the `@@unique` has not been reinstated. A
  future `prisma migrate dev` would otherwise drop both indexes as drift and nothing
  would notice until two colleges' worth of duplicate registers appeared.

---

## 7. The register rules

These five rules are the design. Everything after this section is presentation.

**R1 — Publishing a unit-bearing event with `createRegisters` creates one register per
group**, carrying the event's real date, start, end and room. Roster per D8.

**R2 — An event with no unit gets no register, and says so.** `TimetableEvent.unitId`
is nullable on purpose (exams, workshops, "Study Support", staff meetings);
`HndSession.unitId` is `NOT NULL`. These structurally cannot have registers. The
planner shows *"no register — not a taught session"* rather than skipping silently.

**R3 — Once any mark exists, the register freezes.** Move the event afterwards and the
register does not follow; the planner shows *"register already taken — times no longer
match the timetable"*. Attendance is the record the college is asked to evidence most
often. A design where editing a calendar entry silently rewrites a taken register is
one that eventually loses a dispute. Freezing and *reporting* the divergence is louder
than either following or hiding it.

**R4 — Deleting an event never deletes evidence.** No marks → the register goes with
it. Any marks → the register survives, unlinked, and stays in the attendance record.

**R5 — Blanks are not absences.** A student who did not check in has **no mark**, not
an `A`. This already holds and must not regress. Turning blanks into absences stays the
existing explicit close-off action; §7.4 adds an optional timer for it.

### 7.1 The roster (D8)

```
roster = students in the cohort  ∩  students with an Enrolment on the unit
```

Falling back to **all cohort members** when the unit has *no* enrolment rows at all —
which means Moodle has not synced or the module was added by hand. The register records
which rule produced it and the screen says so, because an empty register and an
unmeasured one look identical and mean opposite things.

Note the shape of that guard: "does this unit have enrolments at all" is a question
about the **unit**, not about the students in this chunk. Asking it per-student
reproduces the most repeated bug in the prediction code.

### 7.2 Merged classes (D6)

One event with two cohorts produces two registers, each with its own roster, marked
independently. They share a room, a time and a lecturer; they do not share a mark
sheet. The dashboard shows them as siblings so a lecturer can see both without
believing they are one.

### 7.3 Clash checking (D4)

On save, three checks run separately — **room**, **staff**, **cohort** — because which
one clashed changes whether the admin cares. Each returns the conflicting events by
name and date. The admin confirms and proceeds; nothing is refused. Colleges
deliberately double-book (online delivery, a room split between groups, a lecturer
listed on a session they only drop into), and a hard block means those stop being
entered rather than stop happening.

### 7.4 Optional auto-close

A setting, **off by default**: blanks become `A` *N* hours after the session ends,
*N* configurable, following the established config pattern. CELCAT ships this at 25
hours. Off by default because converting unmeasured into absent is an institutional
policy decision and not a platform default.

---

## 8. The entry form

One screen creates a whole series.

| Field | Control | Notes |
|---|---|---|
| Module | Search `Unit` | Optional — omitting it means no register (R2) |
| Title | Text | Defaults from the module |
| Lecturer(s) | Search `Staff` | Several allowed; a lecture with a demonstrator is two |
| Group(s) | Search `Cohort` | Several allowed; each produces its own register (D6) |
| Campus | Select `Campus` | Filters the room list |
| Room | Select `Room` | Optional — "Online" has no room |
| Category | Select `EventCategory` | Drives the colour key |
| Time | **Preset or custom** | See below |
| Days | **Weekday checkboxes** | Defaults to the start date's weekday |
| Start date · End date | Two dates | The series window |
| Create registers | Checkbox, default on | Disabled and explained when no module is set |

**Time presets** live in `TimetableSettings.display.timeBlocks`, defaulting to:

```json
[ { "label": "9 to 3",  "start": "09:00", "end": "15:00" },
  { "label": "10 to 5", "start": "10:00", "end": "17:00" },
  { "label": "6 to 9",  "start": "18:00", "end": "21:00" } ]
```

Not hardcoded: the house rule is that a value only changeable by a deploy is not a
setting, and the next college's evening class starts at 17:30. **"6 to 9" is read as
the evening block, 18:00–21:00** — daytime 06:00 has no teaching. Editable if wrong.

**Expansion** reuses the existing `recurrence.js`, extended from one weekday to a set:
every date between start and end whose ISO weekday is ticked, stepped in **UTC** so a
BST boundary cannot nudge a date across midnight, capped at the existing 60-week limit
with the truncation point reported rather than silently dropped.

Before writing, the form shows **how many occurrences and how many registers** it is
about to create. Three ticked weekdays across a 14-week term with two groups is 42
events and 84 registers; that number should be seen before the button, not after.

---

## 9. The three surfaces

### 9.1 Register dashboard

Two levels. **The list**: today's, overdue and upcoming registers — CELCAT's *My
Registers*, and the screen that makes registers actually get taken. **The register
itself**: the students, marked P/L/E/A.

Filters, per the requirement: **student name, student ID (`studentRef`), campus, time,
group.** Campus and time filter the register list; name, ID and group filter within a
register. All filtering is server-side — the reference institution has ~9,000 students
and a client-side filter over that is a page that never paints.

### 9.2 Student app — Check In

Each class today renders **module · lecturer · room · campus · time**, plus a **Check
In** button. `sTapSession` gains `room`, `campus` and `lecturer`, which it can only do
because the register now carries them.

The button opens the scanner already targeted at that class, so the student stops
having to pick which class they are in. The rotating signed code and the wall sticker
still do the proving (D5).

It appears only when it can work — class running now (or inside the lecturer's
held-open window), term open, register exists. When any of those is false the class
still shows in full, with **the reason in place of a dead button**: *"starts at
13:00"*, *"no register for this session"*, *"you're marked present at 09:07"*. A greyed
button with no explanation is how support tickets are generated.

### 9.3 Calendar

The existing CELCAT-shaped views (Day / Week / Month / Timeline / List) gain a **day
detail**: click a day, see everything on it in full — module, lecturer, group, room,
campus, time, category, register status.

**Students read the same table.** `/api/student/me/timetable` is re-pointed from
`TimetableSlot` to `TimetableEvent`, published-only, via
`Student.cohortId → TimetableEventGroup`. Same rows the lecturer sees, so the two can
no longer disagree.

### 9.4 Colour

`TT` in `client/src/timetableTheme.jsx` currently hardcodes University of Westminster's
maroon and green, read off the reference screenshots. It is rewired to the platform's
`--brand-primary` / `--brand-accent` tokens, which every college already sets from
Settings. Category colours stay per-category — a colour key needs distinguishable
colours.

---

## 10. Migrating off `TimetableSlot` (D3)

A tool that is **dry-run by default and cannot be made otherwise by accident**.

It reads `TimetableSlot`, expands each weekly pattern into dated events across the
term, and matches the free-text `lecturer` and `room` strings against real `Staff` and
`Room` rows — **exact and case-insensitive only**. Anything it cannot match is
**reported, never guessed**: a fuzzy match that turns "J. Smith" into the wrong Smith
puts one lecturer's name on another's classes, and is worse than a blank.

The report lists every unmatched string with its row count, so the fix is to add the
missing room or correct the name and re-run. Nothing is written until the report has
been read. The old screen and its endpoints are removed only after a successful run.

---

## 11. Testing

**Pure logic, no database** — multi-weekday recurrence expansion, clash detection,
roster derivation, the migration's name matcher, register-freeze decisions. Files
beside their tests, matching `src/prediction/` and `src/vle/`.

**HTTP smoke suites**, weighted toward negatives as the house style requires:

- A student cannot read another cohort's timetable
- A draft event is invisible to staff and students alike
- **Editing an event does not move a register that has marks** (R3)
- **Deleting an event does not delete marks** (R4)
- A merged class produces two registers, and a mark on one does not appear on the other
- A unitless event produces no register and reports why
- The Check In button's preconditions actually refuse — wrong class, closed term, expired code
- A student token cannot reach the planner or the register dashboard
- The partial indexes actually refuse a duplicate, on both branches

**Every regression test must be proved able to fail** by reintroducing the bug. This is
not ceremony: twice in recent work a test passed while discriminating nothing.

---

## 12. Deliberate non-changes

- **Mark codes stay P/L/E/A.** CELCAT's `N` ("not required") is tempting, but the codes
  are read by the prediction engine, the attendance bands and the Moodle importer.
  A fifth code is a separate change with its own risk and this feature does not need it.
- **`Room.campus` is not dropped** in the migration that consumes it (§6.1).
- **The three-hour-block generator is not deleted**, only demoted: it remains the
  fallback for units with no timetable, labelled as such on screen.

---

## 13. Out of scope

No automatic solver — that is Scientia and TimeEdit's product and decades of constraint
research; we are building the publishing and attendance layers where the newer entrants
are winning. Also excluded: iCal / calendar subscription, drag-and-drop rescheduling,
exam scheduling, seating charts, geofencing, a public web publisher.

**iCal is the fast-follow.** Every product surveyed has it; it is table stakes rather
than a differentiator, and it is cleanly separable from this work.

---

## 14. Risks

| Risk | Handling |
|---|---|
| `prisma migrate dev` silently drops the partial indexes as drift | Schema comment + `schema-contract.test.js` assertion (§6.4) |
| Campus consolidation merges two genuinely different campuses with similar names | `Room.campus` retained for one release; the migration prints every merge it made |
| The `TimetableSlot` migration attaches a class to the wrong lecturer | Exact matching only; unmatched reported, never guessed (§10) |
| A college publishes a whole term, then discovers the times were wrong | The pre-write count (§8); and R3 means only *unmarked* registers move, so the blast radius shrinks as term progresses |
| Register freeze confuses staff who expect the room to update | The divergence is shown on the event, not hidden; wording reviewed before build |

---

## Sources

- [St Mary's University — CELCAT Attendance Monitoring, Staff User Guide (PDF)](https://www.stmarys.ac.uk/deeso/docs/retention-and-attendance/attendance-monitoring-staff-user-guide.pdf) — the primary source for §3
- [St Mary's University — CELCAT User Guide for Staff](https://www.stmarys.ac.uk/timetabling/celcat-user-guide-for-staff.aspx)
- [Celcat — Attendance Monitoring](https://celcat.com/timetabler/extensions/attendance-monitoring/)
- [Celcat — Attendance Monitoring and Registration](https://celcat.com/attendance-monitoring-and-registration/)
- [Celcat — Now](https://celcat.com/timetabler/extensions/now/)
- [Celcat — Publishing](https://celcat.com/timetabler/features/publishing/)
- [SEAtS ONE — Student Attendance Management](https://seatsone.ai/student-attendance-management/)
- [SEAtS — UKVI compliance 2026](https://seatsone.ai/ukvi-compliance-2026-attendance-no-longer-enough/)
- [Qwickly — Attendance Modes](https://www.goqwickly.com/attendance/modes/)
- [Semestry — TermTime Deliver](https://semestry.com/solutions/termtime/deliver)
- [TimeEdit](https://timeedit.com/)
- [25Live by CollegeNET](https://collegenet.com/scheduling/25live)
- [UniTime documentation](https://help.unitime.org/documentation)
- [SUMS — Is it time to change your timetabling system?](https://sums.ac.uk/info-hub/university-timetabling-is-it-time-to-change-your-system/)
