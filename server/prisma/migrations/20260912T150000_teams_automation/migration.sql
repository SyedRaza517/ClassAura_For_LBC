-- Teams automation: auto-created calendar meetings on the timetable, and cohort/unit
-- provisioning into a Team + channel. Both switches default false — see
-- constraints.md — so an unconfigured college makes no Graph calls and this
-- migration changes no visible behaviour on its own.

ALTER TABLE "TimetableEvent" ADD COLUMN "teamsAutoMeeting" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TimetableEvent" ADD COLUMN "teamsCalendarEventId" TEXT;
ALTER TABLE "TimetableEvent" ADD COLUMN "teamsMeetingSyncedAt" TIMESTAMP(3);

-- Nullable, unique when present — exactly Student.msUserId's shape and for its
-- reason: the first provisioning run matches by email, caches the id, and every
-- later run matches by id.
ALTER TABLE "Staff" ADD COLUMN "msUserId" TEXT;
CREATE UNIQUE INDEX "Staff_msUserId_key" ON "Staff"("msUserId");

-- One provisioned class space per cohort. Additive-only: rows are created and
-- updated by teamsProvisioning.js and never deleted by it — deleting the row would
-- orphan the Team in Microsoft with nothing linking it back.
CREATE TABLE "CohortTeam" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3),
    CONSTRAINT "CohortTeam_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CohortTeam_cohortId_key" ON "CohortTeam"("cohortId");
ALTER TABLE "CohortTeam" ADD CONSTRAINT "CohortTeam_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One channel per unit inside a cohort's Team. channelEmail is cached because it is
-- how the meeting invite reaches the channel (app-only cannot post messages), and
-- null records "this tenant has channel email disabled" after one failed read —
-- distinct from "never fetched", which is the empty string default's job.
CREATE TABLE "UnitChannel" (
    "id" TEXT NOT NULL,
    "cohortTeamId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "channelEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UnitChannel_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UnitChannel_cohortTeamId_unitId_key" ON "UnitChannel"("cohortTeamId", "unitId");
ALTER TABLE "UnitChannel" ADD CONSTRAINT "UnitChannel_cohortTeamId_fkey" FOREIGN KEY ("cohortTeamId") REFERENCES "CohortTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UnitChannel" ADD CONSTRAINT "UnitChannel_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Run log for both automations — `job` says which. Mirror of TeamsSync.
CREATE TABLE "TeamsProvisionSync" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "mode" TEXT NOT NULL DEFAULT 'manual',
    "startedBy" TEXT,
    "summary" TEXT NOT NULL DEFAULT '{}',
    "issues" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT,
    CONSTRAINT "TeamsProvisionSync_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TeamsProvisionSync_startedAt_idx" ON "TeamsProvisionSync"("startedAt");

-- The Teams automation switches and settings. No row until the college edits
-- something; the code's defaults carry enabled:false, so an unconfigured college
-- behaves exactly as it did before this feature existed. Mirrors
-- TeamsAttendanceConfig from 20260912T121500_teams_attendance_config.
CREATE TABLE "TeamsAutomationConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TeamsAutomationConfig_pkey" PRIMARY KEY ("id")
);
