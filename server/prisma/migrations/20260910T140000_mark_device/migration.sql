-- Which handset a self check-in was made from.
--
-- Nullable, no backfill and no default. NULL means "not recorded" — every mark a member of
-- staff set, and every self check-in made before this column existed. There is nothing to
-- backfill it from: TagTap holds a device trail for taps, but joining a log row to a mark
-- by student and time would be a guess, and a guessed handset is worse than none in the one
-- comparison this column exists for.
ALTER TABLE "AttendanceMark" ADD COLUMN "deviceId" TEXT;

-- Every mark on one register, grouped by handset. Without it, that is a sequential scan on
-- a table holding a row per student per class per week.
CREATE INDEX "AttendanceMark_sessionId_deviceId_idx" ON "AttendanceMark" ("sessionId", "deviceId");
