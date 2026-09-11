---
paths:
  - "server/src/prediction/**"
  - "server/src/vle/**"
  - "server/src/moodle.js"
  - "server/src/routes/slc.js"
---

## Workload, funding and VLE engagement

**Twelve modules now emit `TRIP_` codes into one `riskDriverCodes` column** —
`tripwires`, `coverage`, `cohort`, `workload`, `funding`, `sessions`, `intake`,
`history`, `divergence`, `assessmentType`, `timetable`, `earlyWindow`. They are written
independently and cannot see each other, so `schema-contract.test.js` asserts the twelve
vocabularies are disjoint and all `TRIP_`-prefixed. A duplicate string would make two
different findings indistinguishable on the screen.

(This said "five" until 5 Sep 2026, seven modules after it stopped being true. The test
is the authority, not this paragraph: anyone adding a thirteenth from the old list would
have checked for collisions against fewer than half the vocabularies that exist.)

**A busy calendar is a figure; a busy calendar PLUS something about this student is a
code.** `assessmentsDueSoon` already established that a timetable fact fires cohort-wide
and must not be a caseload entry. `workload.js` keeps that structurally: every `codes.push`
is guarded by the heavy window AND by this student's own backlog or absence, so neither
half can fire alone.

**VLE engagement costs no extra Moodle calls.** `core_enrol_get_enrolled_users` is already
issued once per course by `syncFromMoodle` and `lastcourseaccess` is already in the
response. A ROW MEANS "WE LOOKED": observed-but-inactive is `accessed: false`, unobservable
is no row at all. This is the one place where absence IS the institution guard, because no
count can separate a disengaged cohort from a Moodle with `$CFG->hiddenuserfields` set from
a college that teaches face to face — all three are zero. The engagement denominator is
DAYS, not rows: a student on four units gets four rows a day, and counting rows makes
someone who opens one course of four every day look 75% disengaged.

**Funding: no `SlcApplication` row means "we do not know", never "no funding".**
Self-funded, employer-sponsored and international students legitimately have none, and
putting them on a risk register for a loan they never wanted is the failure. Every funding
code fires on the PRESENCE of a row saying something specific; none fires on an absence,
and that invariant is the constraint any fourth code must satisfy.

**The funding probe requires a LINKED row.** `count(SlcApplication) > 0` is true at a
college holding four thousand unlinked rows, and the pipeline would then report "no funding
record" about four thousand people who have one. `studentName` and `studentRef` on that
table are plain strings with no relation to `Student`, so matching on them would attach one
student's loan status to another — a data-protection incident, not a bug.

**`SlcApplication.statusChangedOn` is written only when the status actually moves.**
`routes/slc.js` never wrote it at all until recently, so it is null on every older row and
`funding.js` falls back to `applicationDate` — which measures time in the PIPELINE rather
than time in THIS state, and therefore carries a much longer threshold. Do NOT backfill it
from `updatedAt`: that moves when somebody corrects a typo, and the figure would look
freshest for exactly the claims being fussed over rather than the ones nobody has touched.

