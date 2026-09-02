-- Admission Tracker: a course fee, and the tracker's single-row config.
--
-- Purely additive. One nullable column and one new table, no unique constraint on
-- existing data, nothing that can half-apply. Safe on both staging and production.

-- The course fee in PENCE, for the estimated-revenue tile. NULLABLE on purpose: null
-- is "this college has not told us what this course costs", never "this course is
-- free". The tracker drops a fee-less course's enrolments out of the estimate and
-- reports the coverage beside the figure, because a zero read from an unset fee
-- under-reports revenue on an executive screen with nothing to say so.
ALTER TABLE "AdmissionCourse" ADD COLUMN "feeAmountPence" INTEGER;

-- The sixth single-row config table (TenantBranding, AttendanceBandConfig,
-- PredictionModelSettings, AttendanceTapConfig, TimetableSettings are the others),
-- and it takes the same shape: a CONSTANT primary key, upserted on the literal
-- 'singleton'. Two administrators saving at once must collide, not each insert a row
-- and leave `findFirst` picking whichever one the planner returns.
CREATE TABLE "AdmissionTrackerSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "data" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdmissionTrackerSettings_pkey" PRIMARY KEY ("id")
);
