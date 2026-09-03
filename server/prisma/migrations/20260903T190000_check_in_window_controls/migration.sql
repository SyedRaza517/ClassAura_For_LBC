-- The lecturer's hand on the self check-in window, and a device trail on the tap log.
-- All three nullable, no backfill: null is "follow the timetable" / "not recorded",
-- and inventing a value for rows that predate the columns would be inventing facts.
ALTER TABLE "HndSession" ADD COLUMN "checkInClosedAt" TIMESTAMP(3);
ALTER TABLE "HndSession" ADD COLUMN "checkInOpenUntil" TEXT;
ALTER TABLE "TagTap" ADD COLUMN "deviceId" TEXT;
