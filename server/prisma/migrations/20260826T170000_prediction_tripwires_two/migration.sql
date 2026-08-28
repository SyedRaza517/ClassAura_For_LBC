-- Second tripwire tranche: figures the score cannot carry.
--
-- All nullable, for the same reason as the first tranche: every one of these is
-- genuinely unmeasurable for a real student, and a zero here would be read as good
-- news. latenessRate in particular is null whenever the COLLEGE does not record
-- lateness — a rate of 0.0% from a register with no "L" status means "not recorded",
-- not "never late", and shipping it as a clean sheet would be a lie told about every
-- student in the institution at once.
--
-- Added to BOTH tables, or a row writable as a current score but not as history
-- half-succeeds and loses the audit trail.

ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "lastEngagedOn" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "unexplainedShare" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "latenessRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "failCount" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "nearFailCount" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "gradeVolatility" DOUBLE PRECISION;

ALTER TABLE "StudentPredictionHistory" ADD COLUMN "lastEngagedOn" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "unexplainedShare" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "latenessRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "failCount" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "nearFailCount" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "gradeVolatility" DOUBLE PRECISION;
