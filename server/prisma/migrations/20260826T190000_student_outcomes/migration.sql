-- Tranche 4 tripwire columns, and the outcome table.
--
-- StudentOutcome is the single largest gap in this feature. Nothing anywhere records
-- what actually happened to a student, which means every weight in the model is
-- reasoning rather than evidence, and the supervised model the specification promises
-- has no labels to train against. These rows are the labels.
--
-- `reason` is nullable and its vocabulary includes "unknown" on purpose: a college
-- that does not know why a student left should be able to record that it does not
-- know, rather than being forced to guess by a NOT NULL column.
--
-- `effectiveOn` is the date the outcome took effect, never the date it was typed in.
-- Those differ by weeks, and a model trained on the typing date learns when
-- administrators do paperwork.

ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "worstUnitId" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "unitAttendanceSpread" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "unpassedUnitCount" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "attendanceRegularity" DOUBLE PRECISION;

ALTER TABLE "StudentPredictionHistory" ADD COLUMN "worstUnitId" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "unitAttendanceSpread" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "unpassedUnitCount" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "attendanceRegularity" DOUBLE PRECISION;

CREATE TABLE "StudentOutcome" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "effectiveOn" TEXT NOT NULL,
    "stage" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "scoreAtOutcome" DOUBLE PRECISION,
    "riskLevelAtOutcome" TEXT,
    "recordedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "StudentOutcome_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StudentOutcome_studentId_idx" ON "StudentOutcome"("studentId");
CREATE INDEX "StudentOutcome_outcome_idx" ON "StudentOutcome"("outcome");
CREATE INDEX "StudentOutcome_effectiveOn_idx" ON "StudentOutcome"("effectiveOn");
CREATE INDEX "StudentOutcome_tenantId_idx" ON "StudentOutcome"("tenantId");

ALTER TABLE "StudentOutcome" ADD CONSTRAINT "StudentOutcome_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudentOutcome" ADD CONSTRAINT "StudentOutcome_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
