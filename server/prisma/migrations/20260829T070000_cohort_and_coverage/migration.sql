-- Cohort standing, and whether the attendance percentage is worth anything.
--
-- TEN NULLABLE COLUMNS ON BOTH PREDICTION TABLES. Nothing else is altered and nothing is
-- backfilled: every one starts null, and null here means what it means everywhere else in
-- this schema -- not measurable, excluded from denominators, never coerced to zero.
--
-- COHORT STANDING exists because the engine scores every student against fixed absolute
-- thresholds, so 62% attendance is scored identically whether the cohort mean is 58% or
-- 91%. Those are different situations: in the first the student is ordinary and the
-- PROGRAMME is the problem; in the second the student is an outlier who needs a
-- conversation. It is context reported beside the score and never a replacement for it --
-- a student at the 90th percentile of a failing cohort is still failing.
--
-- cohortSize is stored rather than inferred. "Is this a cohort-wide fact" is the question
-- this pipeline has got wrong three times by computing it from a chunk of 200, and a
-- stored population size exactly equal to the chunk size is the fingerprint of that bug.
--
-- cohortStruggling is a FIGURE and not a driver code, because it is true of every student
-- in the cohort at once and riskDriverCodes is a per-student caseload array. A hundred
-- rows carrying an identical reason is no caseload. metrics.js settled the same question
-- for assessmentsDueSoon.
--
-- REGISTER COVERAGE exists because a student with three marked sessions and one with
-- sixty produce numbers that sort in the same column. Worse, three-marked-of-sixty-
-- timetabled is a fact about a tutor not taking the register -- about the COLLEGE -- and
-- it currently reads as a fact about the student. registerCoverageRate is null, not zero,
-- when a college does not timetable at all: no scheduled sessions is unknown coverage.
--
-- lastRegisterMarkOn is the most recent mark of ANY status, which is when the register
-- was last TAKEN -- deliberately not lastAttendedOn, which counts only P and L. It is a
-- DATE and not a day count, because nothing in this feature runs on a schedule and a day
-- passing is not an event, so "21 days" written to a column is wrong by the next morning.


ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "cohortAttendancePercentile" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "cohortAttainmentPercentile" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "cohortSize" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "cohortStruggling" BOOLEAN;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "registerCoverageRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "scheduledSessionCount" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "markedSessionCount" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "attendanceConfidence" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "attendanceObservations" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "lastRegisterMarkOn" TEXT;

ALTER TABLE "StudentPredictionHistory" ADD COLUMN "cohortAttendancePercentile" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "cohortAttainmentPercentile" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "cohortSize" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "cohortStruggling" BOOLEAN;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "registerCoverageRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "scheduledSessionCount" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "markedSessionCount" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "attendanceConfidence" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "attendanceObservations" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "lastRegisterMarkOn" TEXT;
