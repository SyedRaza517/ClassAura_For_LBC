-- Progression risk (predictive analysis).
--
-- Five new tables and nothing else. No existing table is altered, no column is
-- dropped or retyped, and nothing is backfilled: applying this to a live database
-- creates five empty tables and changes the behaviour of exactly nothing until the
-- scoring engine is switched on. A college with no PredictionModelSettings row runs
-- on the platform defaults in code, as with TenantBranding and AttendanceBandConfig.
--
-- Four of the five carry tenantId with a cascading foreign key to Tenant, matching
-- every other tenant-owned table, so the extension in src/db.js can scope them and
-- so deleting a customer takes their data rather than orphaning it.
--
-- The one thing here worth reading twice is AssessmentSubmission. There is no record
-- today of whether a student HANDED WORK IN — AssessmentGrade appears only once the
-- work has been MARKED (moodle.js skips grade items with an empty graderaw), so a
-- marking backlog currently looks identical to a cohort that submitted nothing.

-- CreateTable
--
-- One row per institution at most, and no row until a college edits its settings.
-- The whole configuration lives in one JSONB column because the weights are only
-- valid as a set (they must total 100) and the risk bands are only valid as a set
-- (they must tile 0-100 with no gap), and one column replaces both atomically. A
-- batch recalculation running during a save can therefore never score half a cohort
-- against weights summing to 85.
CREATE TABLE "PredictionModelSettings" (
    "id" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "PredictionModelSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- status is "submitted" | "not_submitted" | "unknown". Three states and not two:
-- most assessments here are LTI/Turnitin grade items rather than mod_assign
-- assignments, and mod_assign_get_submissions returns nothing for those, so for many
-- rows the honest answer is unknown. Unknown is excluded from the submission-rate
-- denominator and must never push a student toward risk.
CREATE TABLE "AssessmentSubmission" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "submittedOn" TEXT,
    "source" TEXT NOT NULL DEFAULT 'moodle',
    "recordedBy" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "AssessmentSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- The latest score for one student, overwritten in place. Every component that fed
-- the total is stored beside it, because staff will not act on a number they cannot
-- explain and "why is this student R4?" has to be answerable from the row itself.
-- baseProgressionScore/baseRiskLevel are the figures BEFORE the override engine ran,
-- kept so "the maths said R2 and a rule pulled it to R3" is visible.
-- The five measured rates are NULLABLE, and null means "could not be measured" — it
-- never means zero. A student whose register has never been taken has no attendance
-- percentage; storing 0 would put them at the top of every Critical Risk screen in
-- the college for something nobody has measured. The engine drops an unmeasurable
-- component from both sides of its weighted mean rather than scoring it, and the
-- screen shows a dash. missingAssessmentCount stays NOT NULL because zero missing
-- assessments is a real, measurable answer.
CREATE TABLE "StudentPredictionCurrent" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "overallAttendance" DOUBLE PRECISION,
    "recentAttendance" DOUBLE PRECISION,
    "submissionRate" DOUBLE PRECISION,
    "onTimeRate" DOUBLE PRECISION,
    "missingAssessmentCount" INTEGER NOT NULL,
    "averageGrade" DOUBLE PRECISION,
    "gradeTrend" TEXT NOT NULL,
    "gradeTrendScore" DOUBLE PRECISION NOT NULL,
    "interventionResponse" TEXT NOT NULL,
    "interventionResponseScore" DOUBLE PRECISION NOT NULL,
    "baseProgressionScore" DOUBLE PRECISION NOT NULL,
    "progressionScore" DOUBLE PRECISION NOT NULL,
    "baseRiskLevel" TEXT NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "directionOfTravel" TEXT NOT NULL,
    "redIndicatorCount" INTEGER NOT NULL DEFAULT 0,
    "overrideApplied" BOOLEAN NOT NULL DEFAULT false,

    -- Structured codes, never display text: rewording a driver must not orphan the
    -- rows already written, and a model trained on these later should not have to
    -- parse English.
    "overrideCodes" JSONB NOT NULL,
    "riskDriverCodes" JSONB NOT NULL,
    "positiveDriverCodes" JSONB NOT NULL,

    "primaryRiskDriver" TEXT,
    "interventionRequired" BOOLEAN NOT NULL DEFAULT false,

    -- Deliberately NOT a foreign key: this row is rewritten on every recalculation
    -- while the intervention it names outlives several of those, so a constraint
    -- here would only turn a stale pointer into a failed batch run.
    "currentInterventionId" TEXT,

    "modelVersion" TEXT NOT NULL,
    "lastCalculated" TIMESTAMP(3) NOT NULL,

    -- Recalculation is batched, not synchronous: taking a register must not wait on
    -- a cohort's worth of scoring. Anything that invalidates a score sets this and
    -- returns; the batch picks up whatever is flagged.
    "stale" BOOLEAN NOT NULL DEFAULT true,

    "tenantId" TEXT NOT NULL,

    CONSTRAINT "StudentPredictionCurrent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- APPEND ONLY. Rows here are never updated and never deleted. Direction of travel is
-- literally "this score minus the row nearest 28 days ago", so editing history
-- rewrites the past, and a model trained on real progression outcomes will train on
-- these rows. The one exception is the student being erased, which cascades.
CREATE TABLE "StudentPredictionHistory" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "calculationDateTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "overallAttendance" DOUBLE PRECISION,
    "recentAttendance" DOUBLE PRECISION,
    "submissionRate" DOUBLE PRECISION,
    "onTimeRate" DOUBLE PRECISION,
    "missingAssessmentCount" INTEGER NOT NULL,
    "averageGrade" DOUBLE PRECISION,
    "gradeTrend" TEXT NOT NULL,
    "gradeTrendScore" DOUBLE PRECISION NOT NULL,
    "interventionResponse" TEXT NOT NULL,
    "interventionResponseScore" DOUBLE PRECISION NOT NULL,
    "baseProgressionScore" DOUBLE PRECISION NOT NULL,
    "progressionScore" DOUBLE PRECISION NOT NULL,
    "baseRiskLevel" TEXT NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "directionOfTravel" TEXT NOT NULL,
    "redIndicatorCount" INTEGER NOT NULL DEFAULT 0,
    "overrideApplied" BOOLEAN NOT NULL DEFAULT false,
    "overrideCodes" JSONB NOT NULL,
    "riskDriverCodes" JSONB NOT NULL,
    "positiveDriverCodes" JSONB NOT NULL,
    "primaryRiskDriver" TEXT,
    "interventionRequired" BOOLEAN NOT NULL DEFAULT false,
    "modelVersion" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "StudentPredictionHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- What a college DID about a student's risk, and what happened next. The metrics are
-- snapshotted onto the row rather than read back from the student's current figures,
-- because the question this answers is "were they worse when we stepped in than they
-- are now?" — unanswerable if the numbers move underneath it.
CREATE TABLE "Intervention" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "interventionDate" TEXT NOT NULL,
    "interventionType" TEXT NOT NULL,
    "riskLevelAtIntervention" TEXT NOT NULL,
    "progressionScoreAtIntervention" DOUBLE PRECISION NOT NULL,
    "attendanceAtIntervention" DOUBLE PRECISION NOT NULL,
    "recentAttendanceAtIntervention" DOUBLE PRECISION NOT NULL,
    "submissionRateAtIntervention" DOUBLE PRECISION NOT NULL,
    "averageGradeAtIntervention" DOUBLE PRECISION NOT NULL,
    "missingAtIntervention" INTEGER NOT NULL,
    "reviewDate" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcome" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Optional link to the pastoral conversation this came out of, so a student has
    -- one story rather than a score, a review and an intervention on three screens.
    "studentReviewId" TEXT,

    "tenantId" TEXT NOT NULL,

    CONSTRAINT "Intervention_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PredictionModelSettings_tenantId_key" ON "PredictionModelSettings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentSubmission_assessmentId_studentId_key" ON "AssessmentSubmission"("assessmentId", "studentId");

-- CreateIndex
CREATE INDEX "AssessmentSubmission_studentId_idx" ON "AssessmentSubmission"("studentId");

-- CreateIndex
CREATE INDEX "AssessmentSubmission_assessmentId_idx" ON "AssessmentSubmission"("assessmentId");

-- CreateIndex
CREATE INDEX "AssessmentSubmission_tenantId_idx" ON "AssessmentSubmission"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentPredictionCurrent_studentId_key" ON "StudentPredictionCurrent"("studentId");

-- CreateIndex
-- This is what the batch selects on, so it is indexed rather than scanned.
CREATE INDEX "StudentPredictionCurrent_stale_idx" ON "StudentPredictionCurrent"("stale");

-- CreateIndex
CREATE INDEX "StudentPredictionCurrent_riskLevel_idx" ON "StudentPredictionCurrent"("riskLevel");

-- CreateIndex
CREATE INDEX "StudentPredictionCurrent_tenantId_idx" ON "StudentPredictionCurrent"("tenantId");

-- CreateIndex
-- The lookup is always "this student, nearest this date", so the pair is the index
-- and studentId on its own is not.
CREATE INDEX "StudentPredictionHistory_studentId_calculationDateTime_idx" ON "StudentPredictionHistory"("studentId", "calculationDateTime");

-- CreateIndex
CREATE INDEX "StudentPredictionHistory_tenantId_idx" ON "StudentPredictionHistory"("tenantId");

-- CreateIndex
CREATE INDEX "Intervention_studentId_idx" ON "Intervention"("studentId");

-- CreateIndex
CREATE INDEX "Intervention_status_idx" ON "Intervention"("status");

-- CreateIndex
CREATE INDEX "Intervention_interventionDate_idx" ON "Intervention"("interventionDate");

-- CreateIndex
CREATE INDEX "Intervention_studentReviewId_idx" ON "Intervention"("studentReviewId");

-- CreateIndex
CREATE INDEX "Intervention_tenantId_idx" ON "Intervention"("tenantId");

-- AddForeignKey
ALTER TABLE "PredictionModelSettings" ADD CONSTRAINT "PredictionModelSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentSubmission" ADD CONSTRAINT "AssessmentSubmission_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentSubmission" ADD CONSTRAINT "AssessmentSubmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentSubmission" ADD CONSTRAINT "AssessmentSubmission_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentPredictionCurrent" ADD CONSTRAINT "StudentPredictionCurrent_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentPredictionCurrent" ADD CONSTRAINT "StudentPredictionCurrent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Cascade even though history is append-only: the only deletion that may reach these
-- rows is the student themselves being erased, and an erasure that left a full
-- behavioural profile behind would not be an erasure.
ALTER TABLE "StudentPredictionHistory" ADD CONSTRAINT "StudentPredictionHistory_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentPredictionHistory" ADD CONSTRAINT "StudentPredictionHistory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SET NULL, not CASCADE: reorganising pastoral records must never destroy the record
-- of an intervention, and an intervention the engine raised on its own never had a
-- review behind it in the first place.
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_studentReviewId_fkey" FOREIGN KEY ("studentReviewId") REFERENCES "StudentReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- WHAT EACH SCORE COVERS.
--
-- Additive, and every column nullable or defaulted, so applying this to a database that
-- already holds predictions leaves them readable — they simply carry an empty scope
-- label until their next recalculation, which is the honest representation of "we did
-- not record what this covered".
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "scopeTermId" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "scopeLabel" TEXT NOT NULL DEFAULT '';
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "scopeFrom" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "scopeTo" TEXT;

ALTER TABLE "StudentPredictionHistory" ADD COLUMN "scopeTermId" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "scopeLabel" TEXT NOT NULL DEFAULT '';
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "scopeFrom" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "scopeTo" TEXT;
