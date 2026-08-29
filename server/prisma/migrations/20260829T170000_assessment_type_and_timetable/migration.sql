-- Which KIND of assessment a student fails, and whether the shape of the teaching day is
-- the reason they are not there.
--
-- Twenty-five nullable columns on each prediction table. Nothing altered, nothing
-- backfilled.
--
-- ASSESSMENT TYPE. Assessment.type has existed since the table did -- "Assignment | Exam |
-- Presentation | Project | Portfolio" -- and nothing in the prediction layer ever read it.
-- So a student who passes every piece of coursework and fails every exam showed an
-- unremarkable average, the average being precisely the operation that hides it. That
-- distinction changes the intervention completely: exam technique, timed-conditions
-- practice and access arrangements are different purchases from essay support, and it is
-- one of the strongest indicators of an undiagnosed access need.
--
-- The code needs an absolute ceiling AND both gaps, which arithmetically forces the
-- pooled rest above 74% -- so a student failing everything cannot fire it, and neither
-- can a cohort. One residual is stated rather than argued away: a genuinely brutal paper
-- a whole cohort failed while passing coursework will fire cohort-wide. It is bounded,
-- and the type is stored, so forty rows saying "Exam" reads as an exam board rather than
-- forty struggling students.
--
-- moodle.js used to hardcode type: "Assignment" on every assessment it created, so this
-- signal could never fire at a synced college -- not because the college had no exams but
-- because the importer flattened them. It now maps Moodle's own itemmodule, which it was
-- already reading to filter attendance items. Only assign and quiz are mapped: a WRONG
-- type is worse than none, because it would produce a confident "fails exams" about a
-- student who has never sat one. And only on CREATE, so a type staff corrected by hand is
-- never re-flattened by the next sync.
--
-- TEACHING DAY SHAPE. An early start, a six-hour day, a two-hour hole in the middle. Each
-- has a cheap concrete fix -- a timetable change, a travel conversation -- and none is
-- visible in any figure that exists. firstSessionAbsenceRate separates "cannot get here"
-- from "not engaged", but says nothing about START TIME, DAY LENGTH or GAPS.
--
-- FIGURES ONLY, NO CODES, and that is the design. A start time is the most cohort-wide
-- fact a college has: everyone on a unit shares its 9am, its six-hour Wednesday and its
-- two-hour hole, so a badly-timetabled unit produces the identical finding for its whole
-- cohort at once. That is a stronger version of the argument sessions.js already made for
-- weekdays, not a weaker one -- a weekday at least varies between units. The missing half
-- is a per-start-time cohort baseline, which belongs in the cohort layer.
--
-- Day length is measured per DAY and not per mark, because a long day holds three or four
-- registers: going home at lunch scores 50% while missing a one-session short day scores
-- 100%, which would make long days look BETTER for exactly the partial attendance they
-- cause. A test pins a fixture where the two disagree in sign.
--
-- A NOTE FOR WHOEVER READS THESE FIRST. The default early-start threshold is 09:30, and
-- on both databases today every session starts at 10:00, 14:00 or 18:00 -- so nothing is
-- "early" and the three early-start figures are null for everyone. That is not the module
-- failing; it is a threshold chosen for a daytime college meeting an evening-heavy one.
-- earlyStartBeforeMinutes is a per-tenant setting for exactly this reason.

ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "worstAssessmentType" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "worstAssessmentTypePassRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "worstAssessmentTypeMeanPct" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "assessmentTypePassRateGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "assessmentTypeMeanGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "assessmentTypesMeasured" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "assessmentTypesSeen" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "untypedGradeCount" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "earlyStartAbsenceRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "laterStartAbsenceRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "earlyStartAbsenceGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "earlyStartLatenessRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "laterStartLatenessRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "earlyStartLatenessGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "earlyStartDays" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "longDayMissedRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "shortDayMissedRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "longDayMissedGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "longDaysMeasured" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "afterLongGapAbsenceRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "afterShortGapAbsenceRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "longGapAbsenceGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "longGapSessions" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "daysWithoutSessionEnd" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "singleSessionDays" INTEGER;

ALTER TABLE "StudentPredictionHistory" ADD COLUMN "worstAssessmentType" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "worstAssessmentTypePassRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "worstAssessmentTypeMeanPct" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "assessmentTypePassRateGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "assessmentTypeMeanGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "assessmentTypesMeasured" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "assessmentTypesSeen" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "untypedGradeCount" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "earlyStartAbsenceRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "laterStartAbsenceRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "earlyStartAbsenceGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "earlyStartLatenessRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "laterStartLatenessRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "earlyStartLatenessGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "earlyStartDays" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "longDayMissedRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "shortDayMissedRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "longDayMissedGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "longDaysMeasured" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "afterLongGapAbsenceRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "afterShortGapAbsenceRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "longGapAbsenceGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "longGapSessions" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "daysWithoutSessionEnd" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "singleSessionDays" INTEGER;
