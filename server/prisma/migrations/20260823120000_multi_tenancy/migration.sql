-- Multi-tenancy: every table becomes owned by exactly one institution.
--
-- Prisma's generated migration for this change adds "tenantId" TEXT NOT NULL with
-- no default and no backfill. That is correct against an empty database and fails
-- immediately against one with rows ("column contains null values") — which is every
-- real deployment. This is the hand-written, data-safe version: add nullable,
-- backfill, then enforce.
--
-- Existing rows all belong to the one institution the system was built for, so they
-- are adopted by a single tenant created here. A deployment with no rows simply
-- gets an unused tenant row, which is harmless.

-- 1. The tenant table.
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");
CREATE INDEX "Tenant_active_idx" ON "Tenant"("active");

-- 2. The tenant that adopts everything already here. Fixed id, so this migration is
--    reproducible and so later migrations and seeds can refer to it.
INSERT INTO "Tenant" ("id", "slug", "name", "active", "createdAt")
VALUES ('tenant_default', 'default', 'Default Institution', true, CURRENT_TIMESTAMP);

-- 3. Add the column NULLABLE first — this is the step Prisma got wrong.
ALTER TABLE "Adjustment" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Admission" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "AdmissionCourse" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "AdmissionDocument" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "AdmissionIntake" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Assessment" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "AssessmentGrade" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "AttendanceEmailConfig" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "AttendanceMark" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "CheckIn" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Cohort" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Course" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "DeviceToken" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Document" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Enrolment" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "HndSession" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Interaction" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Ism" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Leave" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "MoodleSync" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "PasswordReset" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Semester" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "SentNotification" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "SignupRequest" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "SlcApplication" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Staff" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "StaffReview" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Student" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "StudentQuery" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "StudentReview" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Term" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "TermCalendar" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "TimesheetEntry" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "TimetableSlot" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Unit" ADD COLUMN "tenantId" TEXT;

-- 4. Adopt every existing row.
UPDATE "Adjustment" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "Admission" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "AdmissionCourse" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "AdmissionDocument" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "AdmissionIntake" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "Assessment" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "AssessmentGrade" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "AttendanceEmailConfig" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "AttendanceMark" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "CheckIn" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "Cohort" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "Course" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "DeviceToken" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "Document" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "Enrolment" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "HndSession" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "Interaction" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "Ism" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "Leave" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "MoodleSync" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "Notification" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "PasswordReset" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "Semester" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "SentNotification" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "SignupRequest" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "SlcApplication" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "Staff" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "StaffReview" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "Student" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "StudentQuery" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "StudentReview" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "Term" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "TermCalendar" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "TimesheetEntry" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "TimetableSlot" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
UPDATE "Unit" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;

-- 5. Only now can NOT NULL be enforced.
ALTER TABLE "Adjustment" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Admission" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "AdmissionCourse" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "AdmissionDocument" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "AdmissionIntake" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Assessment" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "AssessmentGrade" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "AttendanceEmailConfig" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "AttendanceMark" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "CheckIn" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Cohort" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Course" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "DeviceToken" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Document" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Enrolment" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "HndSession" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Interaction" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Ism" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Leave" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "MoodleSync" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Notification" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "PasswordReset" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Semester" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SentNotification" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SignupRequest" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SlcApplication" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Staff" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "StaffReview" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Student" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "StudentQuery" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "StudentReview" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Term" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "TermCalendar" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "TimesheetEntry" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "TimetableSlot" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Unit" ALTER COLUMN "tenantId" SET NOT NULL;

-- 6. Replace the global unique constraints with per-tenant ones.
--
--    These are business identifiers: two colleges may employ the same person, run a
--    course of the same name, or sync from their own Moodle where the numeric ids
--    restart at 1. Left global, the SECOND customer could not enter their own data.
--
--    Deliberately NOT changed: DeviceToken.token, PasswordReset.tokenHash,
--    Admission.uploadTokenHash and Admission.offerTokenHash stay globally unique.
--    Those are secrets and externally-issued identifiers — a collision across
--    tenants would be a cross-tenant account takeover, so scoping them per tenant
--    would weaken isolation rather than strengthen it.
DROP INDEX "Assessment_moodleItemId_key";
DROP INDEX "Course_moodleCourseId_key";
DROP INDEX "Course_name_key";
DROP INDEX "HndSession_moodleSessionId_key";
DROP INDEX "SignupRequest_email_key";
DROP INDEX "Staff_email_key";
DROP INDEX "Student_email_key";
DROP INDEX "Student_moodleUserId_key";
DROP INDEX "Student_studentRef_key";

CREATE UNIQUE INDEX "Assessment_tenantId_moodleItemId_key" ON "Assessment"("tenantId", "moodleItemId");
CREATE UNIQUE INDEX "Course_tenantId_name_key" ON "Course"("tenantId", "name");
CREATE UNIQUE INDEX "Course_tenantId_moodleCourseId_key" ON "Course"("tenantId", "moodleCourseId");
CREATE UNIQUE INDEX "HndSession_tenantId_moodleSessionId_key" ON "HndSession"("tenantId", "moodleSessionId");
CREATE UNIQUE INDEX "SignupRequest_tenantId_email_key" ON "SignupRequest"("tenantId", "email");
CREATE UNIQUE INDEX "Staff_tenantId_email_key" ON "Staff"("tenantId", "email");
CREATE UNIQUE INDEX "Student_tenantId_moodleUserId_key" ON "Student"("tenantId", "moodleUserId");
CREATE UNIQUE INDEX "Student_tenantId_studentRef_key" ON "Student"("tenantId", "studentRef");
CREATE UNIQUE INDEX "Student_tenantId_email_key" ON "Student"("tenantId", "email");

-- 7. Indexes. Every query the client extension issues filters on tenantId, so
--    without these each one degrades to a sequential scan as customers are added.
CREATE INDEX "Adjustment_tenantId_idx" ON "Adjustment"("tenantId");
CREATE INDEX "Admission_tenantId_idx" ON "Admission"("tenantId");
CREATE INDEX "AdmissionCourse_tenantId_idx" ON "AdmissionCourse"("tenantId");
CREATE INDEX "AdmissionDocument_tenantId_idx" ON "AdmissionDocument"("tenantId");
CREATE INDEX "AdmissionIntake_tenantId_idx" ON "AdmissionIntake"("tenantId");
CREATE INDEX "Assessment_tenantId_idx" ON "Assessment"("tenantId");
CREATE INDEX "AssessmentGrade_tenantId_idx" ON "AssessmentGrade"("tenantId");
CREATE INDEX "AttendanceEmailConfig_tenantId_idx" ON "AttendanceEmailConfig"("tenantId");
CREATE INDEX "AttendanceMark_tenantId_idx" ON "AttendanceMark"("tenantId");
CREATE INDEX "CheckIn_tenantId_idx" ON "CheckIn"("tenantId");
CREATE INDEX "Cohort_tenantId_idx" ON "Cohort"("tenantId");
CREATE INDEX "Course_tenantId_idx" ON "Course"("tenantId");
CREATE INDEX "DeviceToken_tenantId_idx" ON "DeviceToken"("tenantId");
CREATE INDEX "Document_tenantId_idx" ON "Document"("tenantId");
CREATE INDEX "Enrolment_tenantId_idx" ON "Enrolment"("tenantId");
CREATE INDEX "HndSession_tenantId_idx" ON "HndSession"("tenantId");
CREATE INDEX "Interaction_tenantId_idx" ON "Interaction"("tenantId");
CREATE INDEX "Ism_tenantId_idx" ON "Ism"("tenantId");
CREATE INDEX "Leave_tenantId_idx" ON "Leave"("tenantId");
CREATE INDEX "MoodleSync_tenantId_idx" ON "MoodleSync"("tenantId");
CREATE INDEX "Notification_tenantId_idx" ON "Notification"("tenantId");
CREATE INDEX "PasswordReset_tenantId_idx" ON "PasswordReset"("tenantId");
CREATE INDEX "Semester_tenantId_idx" ON "Semester"("tenantId");
CREATE INDEX "SentNotification_tenantId_idx" ON "SentNotification"("tenantId");
CREATE INDEX "SignupRequest_tenantId_idx" ON "SignupRequest"("tenantId");
CREATE INDEX "SlcApplication_tenantId_idx" ON "SlcApplication"("tenantId");
CREATE INDEX "Staff_tenantId_idx" ON "Staff"("tenantId");
CREATE INDEX "StaffReview_tenantId_idx" ON "StaffReview"("tenantId");
CREATE INDEX "Student_tenantId_idx" ON "Student"("tenantId");
CREATE INDEX "StudentQuery_tenantId_idx" ON "StudentQuery"("tenantId");
CREATE INDEX "StudentReview_tenantId_idx" ON "StudentReview"("tenantId");
CREATE INDEX "Term_tenantId_idx" ON "Term"("tenantId");
CREATE INDEX "TermCalendar_tenantId_idx" ON "TermCalendar"("tenantId");
CREATE INDEX "TimesheetEntry_tenantId_idx" ON "TimesheetEntry"("tenantId");
CREATE INDEX "TimetableSlot_tenantId_idx" ON "TimetableSlot"("tenantId");
CREATE INDEX "Unit_tenantId_idx" ON "Unit"("tenantId");

-- 8. Foreign keys last, once every row has a valid tenantId to point at.
--    ON DELETE CASCADE: removing a tenant removes their data, which is what an
--    end-of-contract deletion has to do.
ALTER TABLE "Staff" ADD CONSTRAINT "Staff_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PasswordReset" ADD CONSTRAINT "PasswordReset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SignupRequest" ADD CONSTRAINT "SignupRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Leave" ADD CONSTRAINT "Leave_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Adjustment" ADD CONSTRAINT "Adjustment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Semester" ADD CONSTRAINT "Semester_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Course" ADD CONSTRAINT "Course_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimetableSlot" ADD CONSTRAINT "TimetableSlot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TermCalendar" ADD CONSTRAINT "TermCalendar_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Cohort" ADD CONSTRAINT "Cohort_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Term" ADD CONSTRAINT "Term_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssessmentGrade" ADD CONSTRAINT "AssessmentGrade_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Student" ADD CONSTRAINT "Student_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudentQuery" ADD CONSTRAINT "StudentQuery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Enrolment" ADD CONSTRAINT "Enrolment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HndSession" ADD CONSTRAINT "HndSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendanceMark" ADD CONSTRAINT "AttendanceMark_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MoodleSync" ADD CONSTRAINT "MoodleSync_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffReview" ADD CONSTRAINT "StaffReview_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudentReview" ADD CONSTRAINT "StudentReview_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Admission" ADD CONSTRAINT "Admission_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Ism" ADD CONSTRAINT "Ism_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdmissionDocument" ADD CONSTRAINT "AdmissionDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdmissionCourse" ADD CONSTRAINT "AdmissionCourse_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdmissionIntake" ADD CONSTRAINT "AdmissionIntake_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendanceEmailConfig" ADD CONSTRAINT "AttendanceEmailConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SentNotification" ADD CONSTRAINT "SentNotification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SlcApplication" ADD CONSTRAINT "SlcApplication_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
