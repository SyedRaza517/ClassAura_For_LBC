-- Workload shape, and whether a student's funding is a reason they may not continue.
--
-- Thirteen nullable columns on each prediction table, plus statusChangedOn finally being
-- written by routes/slc.js. No table is created, nothing is altered, nothing backfilled.
--
-- WORKLOAD. assessmentsDueSoon already counts deadlines in the next fortnight, and
-- metrics.js is explicit that it is "a fact about the timetable rather than the student,
-- so it is a figure and never a code -- it would fire cohort-wide". That is right, and it
-- is also the opportunity: four deadlines in one week is ordinary for a cohort, but four
-- deadlines for someone who has not submitted the last two is a caseload entry. So these
-- columns say WHERE the work bunches, and the only things that become CODES are the
-- conjunctions of a heavy window with something about this student.
--
-- peakWeightShare carries peakWasWeighted beside it, because Assessment.weight defaults
-- to 0 and the Moodle importer never sets it -- at a synced college the share is
-- meaningless and a figure that appears to honour the weighting while silently not doing
-- so is the failure the gradeWasWeighted pair already exists to prevent.
--
-- FUNDING. A student whose loan has not come through is at real risk of withdrawing, and
-- it is one of the few risks a college can actually act on. It is also the least visible
-- in academic data: they attend and submit right up until the day they leave.
--
-- THE RULE THAT SHAPES EVERY ONE OF THESE COLUMNS: no row means "we do not know", never
-- "no funding". Self-funded, employer-sponsored and international students legitimately
-- have no SlcApplication at all, and putting them on a risk register for a loan they
-- never wanted is the failure being guarded against. Every code in prediction/funding.js
-- fires on the PRESENCE of a row saying something specific; none fires on an absence.
--
-- fundingNotApplied is a FIGURE and never a code, for three converging reasons: it is the
-- column default, it is also what routes/slc.js rewrites an unrecognised status to (so
-- the string means three things, one of which is a bug), and it would fire cohort-wide at
-- any college that opens a record per student at enrolment.
--
-- A NOTE ON WHY THIS WILL LOOK DEAD ON ARRIVAL. Until the SLC backfill runs, no
-- SlcApplication carries a studentId, so the institution probe is false everywhere and
-- every funding column stays null. That is correct, not broken. The temptation to "fix"
-- it by backfilling statusChangedOn from updatedAt is the confidently-wrong number this
-- comment exists to warn against -- updatedAt moves when somebody corrects a typo.

ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "peakFrom" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "peakTo" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "peakCount" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "peakWeightShare" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "peakWasWeighted" BOOLEAN;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "undatedAssessments" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "carriedBacklogCount" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "fundingPosition" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "fundingUnsettledSince" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "fundingSettledOn" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "fundingRefusedOn" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "fundingApplications" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "fundingNotApplied" INTEGER;

ALTER TABLE "StudentPredictionHistory" ADD COLUMN "peakFrom" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "peakTo" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "peakCount" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "peakWeightShare" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "peakWasWeighted" BOOLEAN;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "undatedAssessments" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "carriedBacklogCount" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "fundingPosition" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "fundingUnsettledSince" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "fundingSettledOn" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "fundingRefusedOn" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "fundingApplications" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "fundingNotApplied" INTEGER;
