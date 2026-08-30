# Assessment Tracker — design

**Date:** 2026-08-30
**Status:** approved for implementation planning
**Phase:** 1 of 2. Phase 2 (LMS submission ingest) is a separate spec.

## What this is

A management view over assessment progress: for each piece of assessed work, which
class and module it belongs to, who leads that module and who teaches it, how many
students are on it, when it is due in, how many handed it in, and how far through
marking the college is against its own marking deadline.

Two screens:

- **Assessment Tracker Setup** — a per-module grid for the fields the tracker needs
  and nothing else: module leader, and each assessment's submission and marking
  deadlines, editable inline across many modules at once.
- **Assessment Tracker** — one row per assessment, grouped under its module, showing
  the figures above.

Both are distinct from the existing **Assessments** page, which stays what it is: a
per-*student* gradebook. The tracker answers "how is this module doing"; Assessments
answers "how did this student do". The one change to Assessments in this phase is a
submitted / not submitted column beside each student's mark (§6).

## What already exists, and what does not

This matters more than usual here, because most of the feature is already in the
database and the temptation is to build a second copy of it.

Already present and populated:

| Concept in the request | Where it already lives |
|---|---|
| module | `Unit` |
| class | `Cohort` (via `Unit.cohortId`, or the student's own cohort) |
| lecturer | `Unit.tutorStaff` (relation) / `Unit.tutor` (legacy free text) |
| total students | `count(Enrolment where unitId)` |
| submission deadline | `Assessment.dueDate` |
| scripts marked | `count(AssessmentGrade where assessmentId)` — real, written by the Moodle sync and by hand |

Present but **empty**, and central to this design:

- `AssessmentSubmission` — the table that answers "did this student hand it in". It is
  read by `prediction/metrics.js` and `routes/prediction.js`. **Nothing writes it.**
  There is no VLE adapter and no importer behind it.

Absent entirely:

- **module leader** — no such field on any model.
- **marking deadline** — no such field on `Assessment`.

Built but unwired, and relevant to phase 2 rather than this one:

- `vle/canvas.js` and `vle/blackboard.js` are complete HTTP clients (auth, paging,
  throttling, connection tests). `vle/canvasNormalise.js` and
  `vle/blackboardNormalise.js` already turn their responses into precisely the
  `{ status, submittedOn, onTime }` shape `AssessmentSubmission` stores, with test
  files longer than the modules themselves. **Nothing calls any of them.** The missing
  piece for Canvas and Blackboard is the writer, not the reader.

## The finding that shapes phase 2, recorded here so it is not rediscovered

`moodle.js` already has the submission date on the wire and discards it.
`gradereport_user_get_grade_items` returns `gradedatesubmitted` per user per item, and
`moodle.js` reads it into `AssessmentGrade.submittedAt` — but only after this line:

```js
if (item.graderaw == null || item.graderaw === "") continue;  // not marked in Moodle yet
```

A student who **submitted but has not yet been marked** is skipped there. That is
exactly the population an assessment tracker exists to count: the submitted-but-unmarked
backlog is the whole point of the marking percentage.

Phase 2 must not assume the fix is simply moving that `continue`. Two risks:

1. This college's assessments are mostly **Turnitin / LTI** grade items, not Moodle
   `assign` activities — see the mapping notes in `vle/moodleItemType.js` and
   `STATUS.md`. `mod_assign_get_submissions`, the reliable Moodle route to submission
   status, **cannot see LTI activities at all**.
2. Whether `gradedatesubmitted` is populated for an unmarked Turnitin submission is
   unverified. It must be checked against a real Moodle before any figure is built on
   it. A `null` there would silently report a college's entire cohort as having
   submitted nothing.

Neither risk is resolved in this phase, and no phase 1 figure depends on either.

## 1. Schema

Two nullable columns and one relation.

```prisma
// on Unit
leaderStaff   Staff?  @relation("UnitLeader", fields: [leaderStaffId], references: [id], onDelete: SetNull)
leaderStaffId String?

// on Assessment
markingDueDate String?   // YYYY-MM-DD
```

Plus the back-relation on `Staff`:

```prisma
unitsLed  Unit[]  @relation("UnitLeader")
```

**Both nullable, deliberately.** A module with no leader named yet is *not measurable*,
not "unassigned" — the tracker renders "—" and excludes it from any count of modules
missing a leader, rather than reporting a college that has not filled the field in yet
as having a problem it does not have. This is the null-is-not-zero rule the codebase
already enforces throughout the academic and prediction code.

`onDelete: SetNull` mirrors `tutorStaffId`: removing a staff account must never cascade
into deleting the modules they led.

`markingDueDate` is a `String?` in `YYYY-MM-DD`, matching every other academic date in
the schema and compared as a string. It sits beside `dueDate`, and the name says which
deadline it is — `Unit.submissionDate` already exists and means something different (the
unit's own hand-in window), so a bare `deadline` would be genuinely ambiguous here.

No new tables. See §9 for why a materialised tracker row was rejected.

## 2. Server — derivations, separated from the queries

New file `server/src/assessmentTracker.js`. **Pure: no database, no network.** Tests
beside it in `assessmentTracker.test.js`, per the repo's convention for logic that gets
argued with.

```
submissionRate(submitted, enrolled)       → null when submitted is null
markingRate(marked, submitted)            → null when submitted is null
coverageRate(marked, enrolled)            → always measurable
deadlineState(dueDate, today)             → "none" | "upcoming" | "due" | "overdue"
markingState(markingDueDate, marked, submitted, today)
```

The rules these encode, each of which is a decision rather than an implementation
detail:

- **`submissionRate` returns `null`, never `0`, when the submission count is unknown.**
  This is the single most important line in the feature. `AssessmentSubmission` is
  empty until phase 2, so a `0` here would put every module in the college on a
  watchlist for something nobody has measured — the failure `CLAUDE.md` names as the
  most repeated bug in this codebase.
- **`markingRate` is marked ÷ *submitted*, not marked ÷ enrolled.** You cannot mark a
  script nobody handed in. A module where 20 of 50 students submitted and all 20 are
  marked is 100% marked, not 40%; the marked-out-of-enrolled reading can never reach
  100% while anyone fails to submit, so a fully-marked module would read as incomplete
  forever and the figure would stop meaning anything to whoever is chasing markers.
  It follows that `markingRate` is `null` until phase 2, and that is correct.
- **`coverageRate` (marked ÷ enrolled) ships alongside it** as a separate, differently
  named figure. It is measurable today, it answers a different real question — how far
  through the cohort this module is — and it is never substituted for `markingRate`
  when that is null. A single column that silently switches denominator per row is
  precisely how a figure becomes untrustworthy.
- **`markingState` is overdue only when work actually remains unmarked.** An assessment
  fully marked a week after its marking deadline is finished, not late. Reporting it as
  overdue would fill the screen with rows nobody can act on, which is the same as an
  empty screen.
- **`deadlineState` takes `today` as an argument** rather than reading a clock, so it
  is testable, and callers pass `localDate()` from `src/clock.js` — never the host
  clock, per the `APP_TIMEZONE` rule.

New file `server/src/routes/assessmentTracker.js`, mounted at `/api/assessment-tracker`.
**Read-only.** Two endpoints:

- `GET /` — tracker rows. Query filters: `courseId`, `cohortId`, `termId`, `unitId`.
- `GET /setup` — the module grid: each unit with its leader, lecturer, cohort,
  enrolled count and its assessments' two deadlines.

Counts come from three `groupBy` queries (`enrolment` by `unitId`, `assessmentGrade` by
`assessmentId`, `assessmentSubmission` by `assessmentId` + `status`), joined in memory —
not one query per row. Tenant scoping is automatic via `db.js`; the router adds nothing
for it and must not try to.

### Two levels of "we do not know"

`submitted` must distinguish three states that all look like an empty column:

1. this college records no submission data at all — true today, for every college;
2. this college records it, but nothing has been synced for *this* assessment;
3. this assessment was synced and genuinely nobody handed anything in.

Only the third is a `0`. The first two are `null`.

**A row means "we looked."** This is the rule `vle/engagementNormalise.js` already
established for VLE engagement, and it applies unchanged: presence of an
`AssessmentSubmission` row is the evidence that the question was asked of this
assessment. So:

- the assessment has **no submission rows at all** → `submitted` is `null`. No count
  can separate "the sync has not reached this assessment" from "fifty students ignored
  it", and reporting the second when the first is true invents a crisis.
- the assessment **has rows** → `submitted` is the count with `status: "submitted"`,
  and a `0` there is a real, earned zero.

The **institution-wide probe** — one unfiltered `prisma.assessmentSubmission.count()`,
evaluated **once per request** — does not change any figure. It chooses the *wording*:
with a count of `0` the column reads "Not synced" across the whole screen, because the
honest explanation is that no integration is feeding it; above `0` an individual null
row reads "Awaiting sync", because the college's other modules plainly are.

That probe is hoisted out of any per-row loop for the reason the five institution-wide
guards in `prediction/` are: computing it from the rows in view answers a question
about the view rather than about the college. `CLAUDE.md` records that this exact
mistake has been made three times in this codebase.

## 3. Writes reuse the endpoints that already exist

No new writers. The setup grid saves through:

- `PUT /api/hnd/units/:id` — gains `leaderStaffId`, handled exactly as the existing
  `tutorStaffId` is in the same body-parsing helper (empty string clears to null; a
  non-empty value is verified to be a real staff member in this tenant before it is
  stored).
- `PUT /api/assessments/:id` — gains `markingDueDate`, validated with `isRealDate` like
  `dueDate` beside it.

A second endpoint writing the same columns is a second place for the validation to
drift. This is backend plumbing only — it does not make the tracker screens any less
separate from the Assessments screen.

**Guard widening.** Both those endpoints currently demand a page the tracker user may
not hold (`registers` and `assessments` respectively), so both widen to
`requireAnyPage([…existing…, "assessment-tracker"])`. There is precedent in this exact
file: `/assessments/exec-summary` already accepts either `executive` or `assessments`,
for the same reason — otherwise an admin granted only the new page gets a screen that
403s on every save.

## 4. Client — two pages, as their own files

`client/src/AssessmentTracker.jsx` and `client/src/AssessmentTrackerSetup.jsx`,
imported into `StaffHub.jsx` the way `AdminLiveAttendance` and `AdminNfcTags` already
are. `StaffHub.jsx` is ~14k lines and there is no client-side test framework at all;
adding two more screens inside it makes the file worse and the screens no easier to
verify.

**Setup grid** — rows are modules. Columns: module (code · name), class/cohort,
lecturer (read-only, set on the existing unit screen), module leader (staff picker),
then per assessment: title, submission deadline, marking deadline. Inline edit, saved
per field.

**Tracker table** — rows are assessments, grouped under their module. Columns: class ·
module · leader · lecturer · enrolled · submission deadline · submitted · submission
rate · marked · coverage · marking % · marking deadline · state. Filterable by course,
cohort and term.

### One permission key, four hand-maintained lists

Key: `assessment-tracker`. One key covers both screens — the setup grid is
configuration for the tracker, not a separate capability worth doubling the maintenance
burden below.

It must be added to **four** lists that nothing joins:

1. `ADMIN_PAGES` in `server/src/validate.js`
2. `ADMIN_PAGES` in `client/src/StaffHub.jsx`
3. `PAGE_LABELS` in `client/src/StaffHub.jsx` — label: "Assessment Tracker"
4. `allNav` in `client/src/StaffHub.jsx` — two entries, both keyed
   `assessment-tracker`

The dev-only `warnOnPageListDrift` check catches omissions from 2, 3 and 4. It cannot
see the server's copy, so 1 is the one to get right by hand.

## 5. What the screen shows when there is no data

| Figure | Phase 1 | Why |
|---|---|---|
| class, module, leader, lecturer | real | already in the database, or newly editable |
| enrolled students | real | `count(Enrolment)` |
| submission deadline | real | `Assessment.dueDate`, already exists |
| marking deadline | real | new column, set on the setup page |
| **marked** | **real** | `count(AssessmentGrade)` — the Moodle sync genuinely populates this |
| **coverage (marked ÷ enrolled)** | **real** | measurable without any submission data |
| submitted | **"Not synced"** | `AssessmentSubmission` is empty and nothing writes it |
| submission rate | **"Not synced"** | null, never 0 — see §2 |
| marking % (marked ÷ submitted) | **"Not synced"** | denominator unknown until phase 2 |

"Not synced" is rendered as distinct from both a zero and a blank cell, so nobody reads
a missing integration as a failing cohort.

## 6. The Assessments page gains a submitted column

The existing per-student gradebook gains one column: submitted / not submitted /
unknown, beside each student's mark.

The seam already exists. `GET /api/assessments/:id/grades` returns one row per enrolled
student, each carrying `marks`, `pct`, `grade`, `source` and `enrolled`. This adds one
field to those rows:

```js
submission: { status, submittedOn, onTime } | null
```

`null` when this student has no `AssessmentSubmission` row, and the student's row
otherwise. **An absent row is never rendered as "not submitted."** The sync writes a
row per enrolled student, so a missing row means the sync did not cover this student —
not that they handed nothing in. Showing "not submitted" against a named individual on
the strength of a row that was never written is the version of this bug that reaches a
student, and `status: "not_submitted"` already exists as an explicit value for when the
LMS actually says so.

No new endpoint. The column renders "Not synced" until phase 2 fills the table, at
which point this page is finished with no further UI work.

**`onTime` is `null` when nothing was submitted**, carried through from the normalisers
— you cannot be on time or late for work never handed in, and a `false` there would
report every non-submitter as a late submitter.

## 7. The Sync button

The tracker carries a sync button in phase 1. It calls the **existing**
`POST /api/moodle/sync`, which is real: it refreshes enrolments and marks, so the
enrolled and marked figures update from it.

It is labelled for exactly what it does and does not claim to fetch submissions. If
`SYNC_PAGES` in `routes/moodle.js` does not already admit a tracker-only admin, it
widens the same way §3 does.

Canvas and Blackboard appear in the setup page's source list as **not yet connected**,
rather than being hidden — a college that has configured Canvas should be told the
tracker is not reading it, not left to infer it from an empty column.

## 8. Testing

**Unit — `server/src/assessmentTracker.test.js`**, run by `node --test`:

- `submissionRate` returns `null`, not `0`, when `submitted` is `null`
- `submissionRate` returns `0` when the assessment **has** submission rows and none of
  them say `"submitted"` — the earned zero of §2, which must still be reachable
- `markingRate` is `null` when `submitted` is `null`
- `markingRate` divides by submitted, not enrolled (20/20 of 50 enrolled is 100%)
- `coverageRate` is never substituted for `markingRate`
- `markingState` is not overdue when everything submitted is marked, past the deadline
- `deadlineState` boundaries: due today is `"due"`, not `"overdue"`

**Smoke — `scripts/smoke-assessment-tracker.mjs`**, weighted negative per house style:

- a non-admin token is refused
- an admin without `assessment-tracker` is 403'd on both endpoints
- an admin with only `assessment-tracker` **can** save a module leader and a marking
  deadline — the guard-widening in §3 is load-bearing and its absence is silent
- with `AssessmentSubmission` empty, `submissionRate` is `null` in the JSON — asserted
  on the wire, not just in the unit test, because the probe lives in the route
- `marked` is a real number in the same response — proving the null above is a
  measurement decision and not a broken query
- a unit belonging to another tenant never appears in either endpoint
- `markingDueDate` rejects a malformed date
- on `GET /assessments/:id/grades`, an enrolled student with no `AssessmentSubmission`
  row comes back with `submission: null` — **not** a `"not_submitted"` status. This is
  the §6 rule, and it is the one whose failure would show a named student as having
  handed nothing in on the strength of a row nobody wrote.

Per `CLAUDE.md`: each regression test is proved to fail by reintroducing the bug before
it counts as coverage. Twice in recent work a test passed while discriminating nothing.

## 9. Alternatives rejected

**A materialised tracker table**, recomputed on data events like
`StudentPredictionCurrent`. Rejected: the prediction cache exists because *scoring* is
expensive. Counting rows is not. A cache here buys no measurable time and adds a whole
class of staleness bug — and this codebase has already learned that lesson in the
opposite direction ("store dates, derive day-counts at render time").

**A standalone `AssessmentTracker` entity** holding its own copy of leader, deadlines
and counts. Rejected: it duplicates `Unit` and `Assessment` data, and duplicated data
drifts. The tracker would eventually disagree with the Assessments page about the same
deadline, and there would be no principled answer to which one is right.

**Deriving submissions from marks already held** (`AssessmentGrade.submittedAt`).
Rejected: a grade exists only once work has been *marked*, so the submission rate could
never exceed the marking rate — which makes both of the headline figures meaningless,
and makes the marking percentage a tautology at 100%.

**Manual entry of submissions.** Rejected by the user: submission data will come from
the LMS APIs only.

## 10. Out of scope — phase 2

The LMS submission ingest, and with it everything in "The finding that shapes phase 2":
the `graderaw == null` skip in `moodle.js`, the Turnitin/LTI gap, and wiring the unused
Canvas and Blackboard clients to a writer. That phase gets its own spec and its own
verification against a real Moodle before any figure depends on it.
