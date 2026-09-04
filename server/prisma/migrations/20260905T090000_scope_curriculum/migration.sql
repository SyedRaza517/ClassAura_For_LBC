-- AlterTable
ALTER TABLE "Cohort" ADD COLUMN     "academicDepartmentId" TEXT;

-- AlterTable
ALTER TABLE "TimetableEvent" ADD COLUMN     "academicDepartmentId" TEXT;

-- AlterTable
ALTER TABLE "TimetableSlot" ADD COLUMN     "academicDepartmentId" TEXT;

-- AlterTable
ALTER TABLE "Unit" ADD COLUMN     "academicDepartmentId" TEXT;

-- CreateIndex
CREATE INDEX "Cohort_academicDepartmentId_idx" ON "Cohort"("academicDepartmentId");

-- CreateIndex
CREATE INDEX "TimetableEvent_academicDepartmentId_idx" ON "TimetableEvent"("academicDepartmentId");

-- CreateIndex
CREATE INDEX "TimetableSlot_academicDepartmentId_idx" ON "TimetableSlot"("academicDepartmentId");

-- CreateIndex
CREATE INDEX "Unit_academicDepartmentId_idx" ON "Unit"("academicDepartmentId");

-- AddForeignKey
ALTER TABLE "TimetableSlot" ADD CONSTRAINT "TimetableSlot_academicDepartmentId_fkey" FOREIGN KEY ("academicDepartmentId") REFERENCES "AcademicDepartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cohort" ADD CONSTRAINT "Cohort_academicDepartmentId_fkey" FOREIGN KEY ("academicDepartmentId") REFERENCES "AcademicDepartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_academicDepartmentId_fkey" FOREIGN KEY ("academicDepartmentId") REFERENCES "AcademicDepartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEvent" ADD CONSTRAINT "TimetableEvent_academicDepartmentId_fkey" FOREIGN KEY ("academicDepartmentId") REFERENCES "AcademicDepartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------
-- Backfill units and cohorts from the course they already belong to.
--
-- Both are plain correlated updates on indexed keys: row locks only, no table rewrite,
-- and safe to re-run because of the IS NULL guard.
UPDATE "Unit"   u  SET "academicDepartmentId" = c."academicDepartmentId"
  FROM "Course" c  WHERE c.id = u."courseId"  AND u."academicDepartmentId" IS NULL;
UPDATE "Cohort" co SET "academicDepartmentId" = c."academicDepartmentId"
  FROM "Course" c  WHERE c.id = co."courseId" AND co."academicDepartmentId" IS NULL;

-- TIMETABLE ROWS ARE DELIBERATELY NOT BACKFILLED, and that is the decision rather than an
-- omission.
--
-- Null there means "shown to everyone". Backfilling from the course would silently confine
-- every existing slot to a department -- and for the course-less ones, a workshop or a
-- study-support session, it would confine them to nothing at all and remove them from every
-- departmental tutor's timetable. That is precisely the regression this column exists to
-- prevent. A college that wants a slot placed in a department says so on the screen.
