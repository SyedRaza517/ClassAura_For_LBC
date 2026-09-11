---
paths:
  - "server/src/prediction/**"
  - "server/src/attendance.js"
---

## Cohort standing and register coverage

**The cohort population and the timetable probe are both built ONCE per run, hoisted.** The
population comes from `StudentPredictionCurrent`, institution-wide, unfiltered by the stale
set — which is one run behind for students being rescored, and that is the lesser evil
against a second implementation of the points model drifting from `attendance.js`.
`cohortSize` is STORED so the classic failure stays detectable: a population size exactly
equal to the chunk size is the fingerprint of it having been built from the chunk.

**The timetable probe counts sessions with NO marks, not sessions.** `count(HndSession) > 0`
is true at every college that ever took one register, because `AttendanceMark.sessionId` is
NOT NULL. If sessions only exist once somebody takes a register, scheduled and marked are
the same set by construction and coverage reads 100% for everybody — manufactured
reassurance, which is the harder mirror of the failure the figure exists to catch.

**`registerCoverage` needs `sessionId` on every mark and refuses without it.** A mark that
cannot be tied to a session cannot be reconciled against the scheduled set, so it returns
null rather than reporting a college with a perfect register as having taken none of it.
The first wiring omitted `sessionId` from the select, and that guard is what caught it —
the marks are flattened from `session.date`, so it is easy to forget the id comes from the
mark itself.

**A signal that fires for a whole cohort at once is a FIGURE, not a code.**
`riskDriverCodes` is a per-student caseload array; a hundred rows carrying an identical
reason is the same as no caseload. `assessmentsDueSoon` and `cohortStruggling` are both
figures for this reason.

**Being below average is not a risk.** Half of every cohort is below the median by
definition, so a cohort signal needs BOTH a rank test and an absolute gap — the bottom
decile of a cohort sitting between 88% and 92% is three points off the mean.

