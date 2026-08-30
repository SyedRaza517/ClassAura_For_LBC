-- Module leader on a unit, and an internal marking deadline on an assessment.
-- Both nullable: an unnamed leader and an unset marking deadline are "not recorded",
-- which the tracker must be able to tell apart from "nobody" and "overdue".
ALTER TABLE "Unit" ADD COLUMN "leaderStaffId" TEXT;
ALTER TABLE "Assessment" ADD COLUMN "markingDueDate" TEXT;

CREATE INDEX "Unit_leaderStaffId_idx" ON "Unit"("leaderStaffId");

-- SetNull, matching tutorStaffId: removing a staff account must never delete the
-- modules they led.
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_leaderStaffId_fkey"
  FOREIGN KEY ("leaderStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
