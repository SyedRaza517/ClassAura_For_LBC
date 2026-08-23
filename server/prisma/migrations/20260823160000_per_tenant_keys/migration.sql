-- DropIndex
DROP INDEX "DeviceToken_token_key";

-- AlterTable
ALTER TABLE "AttendanceEmailConfig" DROP CONSTRAINT "AttendanceEmailConfig_pkey",
ADD CONSTRAINT "AttendanceEmailConfig_pkey" PRIMARY KEY ("tenantId", "id");

-- AlterTable
ALTER TABLE "SentNotification" DROP CONSTRAINT "SentNotification_pkey",
ADD CONSTRAINT "SentNotification_pkey" PRIMARY KEY ("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_tenantId_token_key" ON "DeviceToken"("tenantId", "token");

