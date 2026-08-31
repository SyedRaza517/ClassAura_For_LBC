-- AlterTable
ALTER TABLE "Staff" ADD COLUMN     "supportDepartments" TEXT;

-- CreateTable
CREATE TABLE "SupportDepartmentConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "departments" JSONB NOT NULL DEFAULT '[]',
    "updatedBy" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportDepartmentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "urgency" TEXT NOT NULL DEFAULT 'routine',
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcome" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "outcomeDetail" TEXT NOT NULL DEFAULT '',
    "raisedBy" TEXT,
    "raisedOn" TEXT NOT NULL,
    "acceptedBy" TEXT,
    "acceptedOn" TEXT,
    "closedBy" TEXT,
    "closedOn" TEXT,
    "studentNotified" BOOLEAN NOT NULL DEFAULT false,
    "interactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Referral_studentId_idx" ON "Referral"("studentId");

-- CreateIndex
CREATE INDEX "Referral_department_status_idx" ON "Referral"("department", "status");

-- CreateIndex
CREATE INDEX "Referral_raisedBy_idx" ON "Referral"("raisedBy");

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_interactionId_fkey" FOREIGN KEY ("interactionId") REFERENCES "Interaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

