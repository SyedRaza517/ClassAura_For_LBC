-- Referral hand-offs and the referrer/department conversation.
--
-- Both tables are new and nothing is altered on Referral itself, so this migration is
-- additive: an older build keeps serving while it is applied, which is what the
-- forward-only deploy needs.

-- CreateTable
CREATE TABLE "ReferralTransfer" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "fromDepartment" TEXT NOT NULL,
    "toDepartment" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "notesAtTransfer" TEXT NOT NULL DEFAULT '',
    "transferredBy" TEXT,
    "transferredOn" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralMessage" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "authorRole" TEXT NOT NULL,
    "authorName" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferralTransfer_referralId_idx" ON "ReferralTransfer"("referralId");

-- CreateIndex
CREATE INDEX "ReferralTransfer_fromDepartment_idx" ON "ReferralTransfer"("fromDepartment");

-- CreateIndex
CREATE INDEX "ReferralMessage_referralId_department_idx" ON "ReferralMessage"("referralId", "department");

-- AddForeignKey
ALTER TABLE "ReferralTransfer" ADD CONSTRAINT "ReferralTransfer_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralMessage" ADD CONSTRAINT "ReferralMessage_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE CASCADE ON UPDATE CASCADE;
