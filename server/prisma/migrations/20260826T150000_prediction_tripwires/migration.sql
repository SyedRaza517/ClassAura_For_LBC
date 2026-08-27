-- Tripwires: facts that ride alongside the progression score and never inside it.
--
-- Every column is NULLABLE and that is load-bearing, not laziness. A register nobody
-- has taken gives no absence streak and no last-attended date. A NOT NULL column here
-- would force a zero, and a zero does not mean "no absences" — it means "we never
-- looked". Scoring that as good news is the inversion this whole feature exists to
-- avoid. schema-contract.test.js asserts this and will fail if it is ever changed.
--
-- DATES, NOT DAY-COUNTS. Nothing in this feature runs on a schedule, so a stored
-- "days since last attended" would be wrong by the next morning with no event to
-- correct it. The date stays true; the screen derives the age.
--
-- Added to BOTH tables. A column that can be written as the current score but not as
-- history half-succeeds and loses the audit trail.

ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "absenceStreak" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "lastAttendedOn" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "oldestUnmarkedDueDate" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "attendanceSlope" DOUBLE PRECISION;

ALTER TABLE "StudentPredictionHistory" ADD COLUMN "absenceStreak" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "lastAttendedOn" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "oldestUnmarkedDueDate" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "attendanceSlope" DOUBLE PRECISION;
