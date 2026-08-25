-- Progression risk: the columns that record an UNMEASURABLE component must accept null.
--
-- The predictive-analysis migration made the five measured rates nullable on exactly
-- this reasoning — null means "could not be measured", never zero — and then left the
-- two component SCORES and the intervention snapshot as NOT NULL. That was not a
-- smaller version of the same decision; it was the opposite one, and it stopped the
-- feature working at all.
--
-- WHAT IT BROKE
--
-- engine.js scores a grade trend of INSUFFICIENT_DATA, and an intervention response of
-- NONE or TOO_EARLY, as null — they are absences of evidence, and the engine
-- renormalises them out of the weighted mean rather than inventing a number. Those are
-- not edge cases: a student with no intervention has interventionResponse = NONE, and
-- a student with fewer than four graded marks has gradeTrend = INSUFFICIENT_DATA. On
-- day one that is EVERY student in the college.
--
-- So the first row a recalculation tried to write violated a NOT NULL constraint, the
-- batch had no try/catch around it, and POST /api/prediction/recalculate answered 500
-- having scored nobody. No student could ever be scored. It was never caught because
-- the unit tests exercise the engine, which is pure and correct here, and the HTTP
-- suite that would have written a row had not yet run anywhere.
--
-- THE INTERVENTION SNAPSHOT, same fault one level along
--
-- routes/prediction.js wrote 0 into the snapshot columns when a student had no score
-- yet — and staff can legitimately raise an intervention for such a student, because
-- they notice things the model has no data for. A zero baseline is not neutral: the
-- engine compares today's metrics against it and finds an enormous improvement, so a
-- student nobody ever measured is recorded as having responded well to support. The
-- bias runs one way, and it runs against precisely the students somebody was worried
-- enough to intervene on.
--
-- Widening a column is backward compatible: every row already stored still reads, and
-- nothing that writes a number stops working.

ALTER TABLE "StudentPredictionCurrent" ALTER COLUMN "gradeTrendScore" DROP NOT NULL;
ALTER TABLE "StudentPredictionCurrent" ALTER COLUMN "interventionResponseScore" DROP NOT NULL;

ALTER TABLE "StudentPredictionHistory" ALTER COLUMN "gradeTrendScore" DROP NOT NULL;
ALTER TABLE "StudentPredictionHistory" ALTER COLUMN "interventionResponseScore" DROP NOT NULL;

-- The snapshot of what the student looked like when somebody stepped in. Null here
-- means "we had no figure for this at the time", which is the honest baseline for an
-- intervention raised on a student the model had never scored.
ALTER TABLE "Intervention" ALTER COLUMN "progressionScoreAtIntervention" DROP NOT NULL;
ALTER TABLE "Intervention" ALTER COLUMN "attendanceAtIntervention" DROP NOT NULL;
ALTER TABLE "Intervention" ALTER COLUMN "recentAttendanceAtIntervention" DROP NOT NULL;
ALTER TABLE "Intervention" ALTER COLUMN "submissionRateAtIntervention" DROP NOT NULL;
ALTER TABLE "Intervention" ALTER COLUMN "averageGradeAtIntervention" DROP NOT NULL;

-- riskLevelAtIntervention stays NOT NULL: routes/prediction.js writes the string
-- "UNSCORED" for a student with no score, which is a real answer to "what did we think
-- of them at the time" rather than a missing one.
