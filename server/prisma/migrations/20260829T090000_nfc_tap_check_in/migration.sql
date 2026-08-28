-- AlterTable
ALTER TABLE "CheckIn" ADD COLUMN     "tagId" TEXT;

-- AlterTable
ALTER TABLE "AttendanceMark" ADD COLUMN     "checkedInAt" TEXT;

-- CreateTable
CREATE TABLE "AttendanceTag" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastTapAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "AttendanceTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TagTap" (
    "id" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "studentId" TEXT,
    "staffId" TEXT,
    "sessionId" TEXT,
    "outcome" TEXT NOT NULL,
    "status" TEXT,
    "site" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "TagTap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceTapConfig" (
    "id" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "AttendanceTapConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceTag_code_key" ON "AttendanceTag"("code");

-- CreateIndex
CREATE INDEX "AttendanceTag_tenantId_idx" ON "AttendanceTag"("tenantId");

-- CreateIndex
CREATE INDEX "TagTap_tagId_at_idx" ON "TagTap"("tagId", "at");

-- CreateIndex
CREATE INDEX "TagTap_studentId_idx" ON "TagTap"("studentId");

-- CreateIndex
CREATE INDEX "TagTap_staffId_idx" ON "TagTap"("staffId");

-- CreateIndex
CREATE INDEX "TagTap_tenantId_idx" ON "TagTap"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceTapConfig_tenantId_key" ON "AttendanceTapConfig"("tenantId");

-- AddForeignKey
ALTER TABLE "AttendanceTag" ADD CONSTRAINT "AttendanceTag_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagTap" ADD CONSTRAINT "TagTap_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "AttendanceTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagTap" ADD CONSTRAINT "TagTap_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceTapConfig" ADD CONSTRAINT "AttendanceTapConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

