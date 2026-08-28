-- Three figures the score has never carried.
--
-- weightedAverageGrade exists because Assessment.weight is stored, validated on the way
-- in and shown on the assessment itself, and the engine has never read it -- so a 20%
-- quiz and a 60% project count the same in the average it does report. gradeWasWeighted
-- sits beside it because the Moodle importer never sets weight: at a synced college
-- every assessment carries 0, the figure falls back to the plain mean, and a number
-- that appears to honour the weighting while silently not doing so is exactly the class
-- of failure the null-is-not-zero rule exists to prevent. The flag makes which one you
-- are looking at checkable rather than a matter of trust.
--
-- markingLatencyDays is a STAFF signal. It is reported beside the score and never
-- inside it: a lecturer backlog is not a fact about the student sitting under it. It is
-- null rather than zero when nothing could be timed, because zero reads as "marked the
-- same day" -- praise for a college that recorded no dates at all.
--
-- The first/later session pair separates "cannot get here" from "not engaged". Both
-- produce the same overall attendance percentage and need opposite conversations. Null
-- unless the student has enough days carrying MORE THAN ONE session, since a
-- single-register day has no later session to compare against and counting it would
-- report every absent student at a one-session-a-day college as unable to get up.
--
-- All nullable, on BOTH tables, as schema-contract.test.js requires.

ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "weightedAverageGrade" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "gradeWasWeighted" BOOLEAN;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "markingLatencyDays" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "firstSessionAbsenceRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "laterSessionAbsenceRate" DOUBLE PRECISION;

ALTER TABLE "StudentPredictionHistory" ADD COLUMN "weightedAverageGrade" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "gradeWasWeighted" BOOLEAN;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "markingLatencyDays" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "firstSessionAbsenceRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "laterSessionAbsenceRate" DOUBLE PRECISION;
