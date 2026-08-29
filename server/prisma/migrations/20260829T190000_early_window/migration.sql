-- How a student STARTED, as opposed to how they are doing.
--
-- Thirteen nullable columns on each prediction table. Nothing altered, nothing backfilled.
--
-- This is the best-evidenced family in the progression literature -- attendance and
-- engagement in the first few weeks predict withdrawal better than almost anything
-- measured later -- and nothing in this codebase captured it. Every attendance figure
-- here is either lifetime-to-date or a rolling recent window, and both wash out the start.
--
-- Two questions, both worth answering:
--   a student who started badly and RECOVERED is a success the college should see;
--   a student who started badly and never recovered was visible in week three, and the
--   record should show that they were.
--
-- UNLIKE EVERY OTHER FIGURE IN THESE TABLES, THESE STOP MOVING. Week 1-4 attendance is
-- the same number in June as it was in October, because the window is date-bounded rather
-- than rolling. If one of these ever drifts, something is wrong.
--
-- NO CODES, and the argument is stronger here than anywhere else it has been made. A
-- cohort opening window is not merely SHARED between neighbours -- it is literally the
-- same four calendar dates for every student in the cohort, because it is derived from
-- the cohort start date. Freshers'' week, a late timetable, a room change: all produce a
-- poor opening for the whole intake at once. Four escapes were considered and rejected;
-- the decisive one is that "bad start AND still bad" merely restates overallAttendance,
-- which has already moved the band. The never-started case is caught three times over by
-- TRIP_ABSENCE_STREAK, TRIP_WEEKS_UNSEEN and TRIP_NOT_SEEN.
--
-- THE WINDOW NEEDS A PROGRAMME START DATE, AND IT IS NOT Student.createdAt. metrics.js
-- says why in terms: for a Moodle-imported college that is the SYNC date. Confirmed
-- empirically -- every Student.createdAt and Enrolment.createdAt on both databases is
-- 2026-08-25, the seed date. The date comes from the cohort''s own startDate, the same
-- source weeksIntoProgramme uses, and a null start date means NO WINDOW and every figure
-- null. There is deliberately no fallback to the earliest mark, which would define the
-- window as "whenever we happened to start looking" and would produce a confident figure
-- for exactly the students whose records are worst.
--
-- ON BOTH DATABASES TODAY THERE ARE NO COHORTS AND NO TERMS AT ALL, so programmeStartOn
-- is null for every student and all thirteen columns will be null. That is the guard
-- working, and it is the same root cause as cohortId being null everywhere.

ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "earlyAttendance" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "earlyAttendanceMarked" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "subsequentAttendance" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "subsequentAttendanceMarked" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "earlyAttendanceGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "earlyWindowEndsOn" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "preStartMarked" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "firstAssessmentPct" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "firstAssessmentOn" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "subsequentAverageGrade" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "subsequentGradeCount" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "firstAssessmentGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "undatedGradeCount" INTEGER;

ALTER TABLE "StudentPredictionHistory" ADD COLUMN "earlyAttendance" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "earlyAttendanceMarked" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "subsequentAttendance" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "subsequentAttendanceMarked" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "earlyAttendanceGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "earlyWindowEndsOn" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "preStartMarked" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "firstAssessmentPct" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "firstAssessmentOn" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "subsequentAverageGrade" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "subsequentGradeCount" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "firstAssessmentGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "undatedGradeCount" INTEGER;
