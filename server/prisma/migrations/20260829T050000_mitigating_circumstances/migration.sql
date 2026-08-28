-- Mitigating circumstances: recording that the college granted somebody extra time.
--
-- WHY. TRIP_CHRONIC_LATE is live today. moodle.js populates AssessmentGrade.submittedAt
-- from gradedatesubmitted, and metrics.js compares it against the assessment's own
-- dueDate. Nothing in this schema recorded that a college had granted an extension, so
-- the comparison used the only date it had: the original one. The college therefore
-- reported a student as chronically late for using an accommodation the college itself
-- granted them, and nothing on the screen said so. That is not a gap in coverage; it is
-- the model being wrong about a fact the institution already knows.
--
-- Two new tables and four new nullable columns on the two prediction tables. No existing
-- column is dropped or retyped and nothing is backfilled. Applying this to a live
-- database creates two empty tables; with no claims in them, prediction/adjustments.js
-- returns each assessment's own dueDate unchanged, which is today's behaviour exactly.
--
-- SPECIAL CATEGORY DATA. A mitigating circumstance is very often health data: illness,
-- mental health, bereavement, pregnancy, a caring responsibility. Under UK GDPR Article 9
-- that is special category data, collected for student support rather than for building a
-- risk score. The row is shaped around that: status/coversFrom/coversTo/coversAttendance
-- and the adjustments say WHAT the college decided and are the only fields the prediction
-- pipeline selects; category and detail say WHY and are never selected by anything under
-- server/src/prediction/. The engine must know THAT a student has cover, never WHY.
--
-- The audit trail records the fact of a decision and never the category, matching the
-- rule interactions.js already applies to pastoral notes: the audit log is read on
-- Settings and Staff by admins who were never granted this page.

-- CreateTable
--
-- status is "open" | "approved" | "rejected" | "withdrawn". APPROVED and OPEN suppress;
-- REJECTED and WITHDRAWN contribute nothing. The undecided case is the argued one and is
-- set out at length in prediction/adjustments.js -- briefly: with a claim pending, "did
-- this student fail to hand work in" is not a question about the student at all, because
-- the answer depends on a decision the institution has not taken. Counting it against
-- them would punish the student for the length of the college's own decision queue.
--
-- coversFrom/coversTo are capped at validation. An unbounded window is a permanent
-- suppression, and a permanent suppression is indistinguishable from the student having
-- been taken off the risk register altogether.
--
-- coversAttendance is opt-in per claim and never implied by a category: suppressing
-- attendance removes sessions from BOTH sides of the percentage, which is a far larger
-- act than suppressing a submission count.
--
-- updatedAt exists because the "how long has this been undecided" watermark must not be
-- taken from raisedOn, which is backdatable by design. The same fault had to be fixed on
-- Interaction, which had no updatedAt at all.
CREATE TABLE "MitigatingCircumstance" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "coversFrom" TEXT NOT NULL,
    "coversTo" TEXT NOT NULL,
    "coversAttendance" BOOLEAN NOT NULL DEFAULT false,
    "category" TEXT,
    "detail" TEXT NOT NULL DEFAULT '',
    "raisedOn" TEXT NOT NULL,
    "decidedOn" TEXT,
    "decidedBy" TEXT,
    "decisionNote" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "MitigatingCircumstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- What a claim actually changed for one piece of work.
--
-- A claim with NO rows here is not incomplete. It is the ordinary state at the moment of
-- approval, before anybody has sat down to set new dates, and it is precisely when the
-- student most needs the cover -- so prediction/adjustments.js treats such a claim as a
-- blanket window over the work due inside it rather than making cover wait on
-- administrative work that has not happened yet.
--
-- adjustmentType is "extension" | "exclusion". An extension is a new DEADLINE, not an
-- exemption: one that has itself run out makes the work late again. An exclusion leaves
-- BOTH sides of every fraction -- never counted as submitted, never as on time, never as
-- missing. That is the null-is-not-zero rule pointed the other way, and getting it
-- backwards is the mirror-image harm of the bug being fixed here: counting an extended
-- assessment as handed in on time inflates the score of a student in genuine difficulty
-- and quietly removes them from the register.
CREATE TABLE "AssessmentAdjustment" (
    "id" TEXT NOT NULL,
    "circumstanceId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "adjustmentType" TEXT NOT NULL,
    "revisedDueDate" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "AssessmentAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MitigatingCircumstance_studentId_idx" ON "MitigatingCircumstance"("studentId");

-- CreateIndex
CREATE INDEX "MitigatingCircumstance_status_idx" ON "MitigatingCircumstance"("status");

-- CreateIndex
CREATE INDEX "MitigatingCircumstance_coversFrom_idx" ON "MitigatingCircumstance"("coversFrom");

-- CreateIndex
CREATE INDEX "MitigatingCircumstance_tenantId_idx" ON "MitigatingCircumstance"("tenantId");

-- CreateIndex
--
-- One adjustment per assessment per claim. Two claims may still both touch the same
-- assessment -- a student can have an illness and a bereavement in the same term -- and
-- prediction/adjustments.js resolves that by taking the MOST GENEROUS: an exclusion beats
-- an extension, a later deadline beats an earlier one. Failing toward the student is the
-- only safe direction for a rule whose failure mode is punishing somebody for an
-- accommodation their college granted.
CREATE UNIQUE INDEX "AssessmentAdjustment_circumstanceId_assessmentId_key" ON "AssessmentAdjustment"("circumstanceId", "assessmentId");

-- CreateIndex
CREATE INDEX "AssessmentAdjustment_assessmentId_idx" ON "AssessmentAdjustment"("assessmentId");

-- CreateIndex
CREATE INDEX "AssessmentAdjustment_tenantId_idx" ON "AssessmentAdjustment"("tenantId");

-- AddForeignKey
ALTER TABLE "MitigatingCircumstance" ADD CONSTRAINT "MitigatingCircumstance_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MitigatingCircumstance" ADD CONSTRAINT "MitigatingCircumstance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentAdjustment" ADD CONSTRAINT "AssessmentAdjustment_circumstanceId_fkey" FOREIGN KEY ("circumstanceId") REFERENCES "MitigatingCircumstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentAdjustment" ADD CONSTRAINT "AssessmentAdjustment_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentAdjustment" ADD CONSTRAINT "AssessmentAdjustment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
--
-- Four figures reported BESIDE the score, and one of them is about the college rather
-- than the student.
--
-- openMitigationCount and oldestOpenMitigationOn are a STAFF signal, in the same family
-- as markingLatencyDays and overdueFollowUpCount: a claim sitting undecided is a fact
-- about the institution's decision queue, and the student underneath it is the person
-- being harmed by the delay. It is reported and never scored.
--
-- oldestOpenMitigationOn is a DATE, not a day count. Nothing in this feature runs on a
-- schedule -- markStale() fires on data events and a day passing is not an event -- so
-- "sitting for 19 days" written to a column is wrong by the next morning with nothing to
-- correct it, while the date is true for ever. The screen subtracts.
--
-- mitigatedAssessmentCount tells a reader that the denominator shrank. Without it, a
-- submission rate of 100% from two assessments looks identical to one from twelve, and
-- the suppression this feature exists to perform becomes invisible on the screen it was
-- performed for.
--
-- attendanceMitigated is nullable rather than defaulting false, because "no claim covers
-- attendance" and "we have not looked" are different facts and only the first is a
-- finding.
--
-- All nullable, on BOTH tables, identically -- as schema-contract.test.js requires.
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "openMitigationCount" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "oldestOpenMitigationOn" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "mitigatedAssessmentCount" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "attendanceMitigated" BOOLEAN;

ALTER TABLE "StudentPredictionHistory" ADD COLUMN "openMitigationCount" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "oldestOpenMitigationOn" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "mitigatedAssessmentCount" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "attendanceMitigated" BOOLEAN;
