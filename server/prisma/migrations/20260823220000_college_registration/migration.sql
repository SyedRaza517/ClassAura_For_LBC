-- Organisations applying to join the platform.
--
-- Purely additive: one new table, nothing existing altered, and it is NOT related to
-- Tenant by a foreign key. That is deliberate. A Tenant is a customer we have already
-- accepted; a row here is an application from a stranger who filled in a public form.
-- Tying them together would put unvetted submissions in the estate — counted in usage,
-- and reachable at a URL, because tenant resolution works off slug — before anybody
-- had looked at one.
--
-- `tenantId` is therefore a plain column, not a relation: it records which institution
-- an application BECAME, and is null until it becomes one.

CREATE TABLE "CollegeRegistration" (
    "id" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    "legalName" TEXT NOT NULL,
    "tradingName" TEXT,
    "institutionType" TEXT,
    "registrationNumber" TEXT,
    "website" TEXT,
    "addressLines" TEXT,
    "country" TEXT,
    "approxStaff" INTEGER,
    "approxStudents" INTEGER,

    "contactName" TEXT NOT NULL,
    "contactRole" TEXT,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,

    "requestedSlug" TEXT,
    "notes" TEXT,

    "status" TEXT NOT NULL DEFAULT 'pending',

    -- Hashed, like a password-reset token. This code is the only thing between an
    -- approved application and a live institution, so a readable copy in the database
    -- — or in a backup, or on screen in Prisma Studio — defeats the control entirely.
    "accessCodeHash" TEXT,
    "accessCodeHint" TEXT,
    "codeIssuedAt" TIMESTAMP(3),
    "codeExpiresAt" TIMESTAMP(3),
    "codeAttempts" INTEGER NOT NULL DEFAULT 0,

    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "decisionNote" TEXT,

    "tenantId" TEXT,

    CONSTRAINT "CollegeRegistration_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CollegeRegistration_status_idx" ON "CollegeRegistration"("status");
CREATE INDEX "CollegeRegistration_contactEmail_idx" ON "CollegeRegistration"("contactEmail");
