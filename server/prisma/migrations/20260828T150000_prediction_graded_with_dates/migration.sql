-- The denominator behind lateSubmissionRate.
--
-- Stored so a percentage can be checked against the sample it came from. The engine
-- now refuses to raise TRIP_CHRONIC_LATE below a configurable minimum, but the figure
-- itself is still reported, and "60% late" over three pieces is a different claim from
-- the same number over thirty. Nullable like every other tripwire figure: a student
-- with no marked, dated work has no denominator rather than a denominator of zero.

ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "gradedWithDates" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "gradedWithDates" INTEGER;
