-- The Teams attendance switch and threshold. No row until the college edits
-- something; the code's defaults carry enabled:false, so an unconfigured college
-- behaves exactly as it did before this feature existed.
CREATE TABLE "TeamsAttendanceConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TeamsAttendanceConfig_pkey" PRIMARY KEY ("id")
);
