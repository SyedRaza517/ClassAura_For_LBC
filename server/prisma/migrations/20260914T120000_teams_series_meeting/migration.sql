-- CreateTable
CREATE TABLE "TeamsSeriesMeeting" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "calendarEventId" TEXT NOT NULL,
    "joinUrl" TEXT NOT NULL,
    "meetingId" TEXT,
    "organizerId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "coorganizersSetAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamsSeriesMeeting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeamsSeriesMeeting_seriesId_key" ON "TeamsSeriesMeeting"("seriesId");

-- CreateIndex
CREATE INDEX "TeamsSeriesMeeting_seriesId_idx" ON "TeamsSeriesMeeting"("seriesId");
