-- Fifth tripwire tranche.
--
-- All nullable, same rule as the previous two: every one of these is genuinely
-- unmeasurable for a real student. lateSubmissionRate in particular is null whenever
-- the college's feed carries no submission dates — nothing writes AssessmentSubmission
-- at all, and AssessmentGrade.submittedAt is only populated by the Moodle importer, so
-- a college on a different VLE has none. "0% late" there describes the integration.
--
-- weeksIntoProgramme is null when the cohort has neither a start date nor terms, and
-- the engine deliberately does NOT read that null as "brand new" — doing so would mute
-- every disengagement code for exactly the students the calendar already cannot place.

ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "lateSubmissionRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "meanDaysLate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "weeksIntoProgramme" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "assessmentsDueSoon" INTEGER;

ALTER TABLE "StudentPredictionHistory" ADD COLUMN "lateSubmissionRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "meanDaysLate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "weeksIntoProgramme" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "assessmentsDueSoon" INTEGER;
