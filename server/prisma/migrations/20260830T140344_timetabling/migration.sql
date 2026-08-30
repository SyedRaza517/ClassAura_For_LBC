-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "floor" TEXT NOT NULL DEFAULT '',
    "campus" TEXT NOT NULL DEFAULT '',
    "capacity" INTEGER,
    "kind" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "colour" TEXT NOT NULL DEFAULT '#1a3a8f',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "EventCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableEvent" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "unitId" TEXT,
    "courseId" TEXT,
    "roomId" TEXT,
    "categoryId" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "TimetableEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableEventStaff" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "TimetableEventStaff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableEventGroup" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "TimetableEventGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableSettings" (
    "id" TEXT NOT NULL,
    "display" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "TimetableSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableUserPref" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "display" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "TimetableUserPref_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Room_tenantId_active_idx" ON "Room"("tenantId", "active");

-- CreateIndex
CREATE INDEX "Room_tenantId_idx" ON "Room"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Room_tenantId_name_campus_key" ON "Room"("tenantId", "name", "campus");

-- CreateIndex
CREATE INDEX "EventCategory_tenantId_active_idx" ON "EventCategory"("tenantId", "active");

-- CreateIndex
CREATE INDEX "EventCategory_tenantId_idx" ON "EventCategory"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "EventCategory_tenantId_name_key" ON "EventCategory"("tenantId", "name");

-- CreateIndex
CREATE INDEX "TimetableEvent_tenantId_date_idx" ON "TimetableEvent"("tenantId", "date");

-- CreateIndex
CREATE INDEX "TimetableEvent_roomId_idx" ON "TimetableEvent"("roomId");

-- CreateIndex
CREATE INDEX "TimetableEvent_unitId_idx" ON "TimetableEvent"("unitId");

-- CreateIndex
CREATE INDEX "TimetableEvent_tenantId_idx" ON "TimetableEvent"("tenantId");

-- CreateIndex
CREATE INDEX "TimetableEventStaff_staffId_idx" ON "TimetableEventStaff"("staffId");

-- CreateIndex
CREATE INDEX "TimetableEventStaff_tenantId_idx" ON "TimetableEventStaff"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TimetableEventStaff_eventId_staffId_key" ON "TimetableEventStaff"("eventId", "staffId");

-- CreateIndex
CREATE INDEX "TimetableEventGroup_cohortId_idx" ON "TimetableEventGroup"("cohortId");

-- CreateIndex
CREATE INDEX "TimetableEventGroup_tenantId_idx" ON "TimetableEventGroup"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TimetableEventGroup_eventId_cohortId_key" ON "TimetableEventGroup"("eventId", "cohortId");

-- CreateIndex
CREATE INDEX "TimetableSettings_tenantId_idx" ON "TimetableSettings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TimetableSettings_tenantId_key" ON "TimetableSettings"("tenantId");

-- CreateIndex
CREATE INDEX "TimetableUserPref_tenantId_idx" ON "TimetableUserPref"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TimetableUserPref_tenantId_staffId_key" ON "TimetableUserPref"("tenantId", "staffId");

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventCategory" ADD CONSTRAINT "EventCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEvent" ADD CONSTRAINT "TimetableEvent_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEvent" ADD CONSTRAINT "TimetableEvent_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEvent" ADD CONSTRAINT "TimetableEvent_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEvent" ADD CONSTRAINT "TimetableEvent_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "EventCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEvent" ADD CONSTRAINT "TimetableEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEventStaff" ADD CONSTRAINT "TimetableEventStaff_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "TimetableEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEventStaff" ADD CONSTRAINT "TimetableEventStaff_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEventStaff" ADD CONSTRAINT "TimetableEventStaff_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEventGroup" ADD CONSTRAINT "TimetableEventGroup_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "TimetableEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEventGroup" ADD CONSTRAINT "TimetableEventGroup_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEventGroup" ADD CONSTRAINT "TimetableEventGroup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSettings" ADD CONSTRAINT "TimetableSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableUserPref" ADD CONSTRAINT "TimetableUserPref_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableUserPref" ADD CONSTRAINT "TimetableUserPref_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
