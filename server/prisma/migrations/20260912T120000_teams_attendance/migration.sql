-- Teams auto-attendance: the meeting link on the timetable and the register, the
-- resolved meeting identity, the "report fetched" marker, the student's Microsoft id,
-- and the sync run log. All nullable / defaulted — a college that never configures
-- Teams sees no behaviour change (null means "not an online class", not zero).

ALTER TABLE "TimetableEvent" ADD COLUMN "teamsJoinUrl" TEXT NOT NULL DEFAULT '';

ALTER TABLE "HndSession" ADD COLUMN "teamsJoinUrl" TEXT;
ALTER TABLE "HndSession" ADD COLUMN "teamsMeetingId" TEXT;
ALTER TABLE "HndSession" ADD COLUMN "teamsOrganizerId" TEXT;
ALTER TABLE "HndSession" ADD COLUMN "teamsCollectedAt" TIMESTAMP(3);

-- Nullable, unique when present — exactly moodleUserId's shape and for its reason:
-- the first sync matches by email, caches the id, and every later sync matches by id.
ALTER TABLE "Student" ADD COLUMN "msUserId" TEXT;
CREATE UNIQUE INDEX "Student_msUserId_key" ON "Student"("msUserId");

CREATE TABLE "TeamsSync" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "mode" TEXT NOT NULL DEFAULT 'manual',
    "startedBy" TEXT,
    "summary" TEXT NOT NULL DEFAULT '{}',
    "issues" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT,
    CONSTRAINT "TeamsSync_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TeamsSync_startedAt_idx" ON "TeamsSync"("startedAt");
