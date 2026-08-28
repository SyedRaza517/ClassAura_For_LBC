-- The SHAPE of a student's absence, as opposed to the amount of it.
--
-- Thirteen nullable columns on each prediction table. Nothing is altered or backfilled.
--
-- WHY SHAPE. Two students on 70% attendance are not the same student. One misses every
-- Friday -- a clash, a shift, a caring commitment, and fixable by moving one session. The
-- other is absent at random, which is disengagement. The percentage cannot tell them
-- apart and neither can anything else already stored here.
--
-- THE WEEKDAY AND KIND FIGURES RAISE NO CODES, AND THAT IS THE DESIGN. Within one
-- student's own marks there is nothing separating "this student misses Fridays" from
-- "nobody attends the Friday nine o'clock" -- and CLAUDE.md names that exact case as a
-- fact about the timetable rather than about the student. The half that would separate
-- them is the cohort's Friday, which belongs to the cohort layer. So these are reported
-- for a human to read beside the score, and the only code here is the one that survives
-- that test.
--
-- unseenWeekRun counts whole WEEKS in which the register ran and the student appeared in
-- none of them. It is deliberately none of the three things it resembles:
--   * absenceStreak counts consecutive absent ROWS. A partial week breaks this and not a
--     streak; a week with no sessions timetabled produces no marks and breaks neither.
--   * TRIP_NOT_SEEN reads the calendar, so it fires college-wide every summer. This
--     cannot fire on a closed college at all, because a closed college produces no marks
--     to observe -- absence of a register is not evidence about a student.
--   * lastAttendedOn is a date, not a run, and says nothing about whether the register
--     was even taken in between.
--
-- kind is empty on every HndSession row in both databases today, so the four kind columns
-- will be null everywhere until a college starts recording it. That is the institution
-- guard working: "does this college record kinds at all" is asked once per run of the
-- whole tenant, never derived from one chunk of students.

ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "worstAbsenceWeekday" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "worstWeekdayAbsenceRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "weekdayAbsenceGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "weekdaysMeasured" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "worstAbsenceKind" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "worstKindAbsenceRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "kindAbsenceGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "kindsMeasured" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "unseenWeekRun" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "unseenSinceWeekOn" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "lastAttendedWeekOn" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "longestUnseenWeekRun" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "observedWeeks" INTEGER;

ALTER TABLE "StudentPredictionHistory" ADD COLUMN "worstAbsenceWeekday" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "worstWeekdayAbsenceRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "weekdayAbsenceGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "weekdaysMeasured" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "worstAbsenceKind" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "worstKindAbsenceRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "kindAbsenceGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "kindsMeasured" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "unseenWeekRun" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "unseenSinceWeekOn" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "lastAttendedWeekOn" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "longestUnseenWeekRun" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "observedWeeks" INTEGER;
