-- Removing multi-tenancy: one deployment now serves one institution.
--
-- READ THIS BEFORE RUNNING IT ANYWHERE.
--
-- `tenantId` is half of 18 unique constraints — [tenantId, studentRef],
-- [tenantId, email] on both Student and Staff, [tenantId, moodleUserId], and so on.
-- Dropping the column turns each into a plain unique. That has two consequences and
-- both are worse than an ordinary migration failure:
--
--   * where two institutions share a student number or an email address, creating the
--     plain unique FAILS, and
--   * where it succeeds, the drop does not separate the institutions, it MERGES them.
--     Every student, register and pastoral note lands in one undifferentiated pile,
--     and the only record of who belonged to whom is the column being dropped.
--
-- The second is unrecoverable from the data afterwards. So this refuses to run
-- against a database holding more than one institution, rather than trusting that it
-- does not. Postgres runs the whole migration in one transaction, so a raise here
-- leaves the database exactly as it was.
--
-- If this fails: you have more than one institution in this database. The fix is to
-- split it into one database per college FIRST, or to delete the surplus tenants and
-- their rows deliberately. It is never to weaken this check.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "Tenant";
  IF n > 1 THEN
    RAISE EXCEPTION
      'Refusing to remove multi-tenancy: % institutions hold data in this database. Dropping tenantId would merge them irreversibly. See the comment at the top of this migration.', n;
  END IF;
END $$;

-- THE CONFIG SINGLETONS HAVE TO BE RENUMBERED, AND THIS IS NOT COSMETIC.
--
-- Five tables held one row per institution, guaranteed by a unique on tenantId.
-- That column is going, so the guarantee is now a constant primary key: their id
-- defaults to 'singleton', and the code upserts on that literal.
--
-- A default only applies to rows created AFTER it exists. Every row already in this
-- database was created with a cuid, so an upsert on 'singleton' would match nothing
-- and INSERT A SECOND ROW beside the real one. The readers use findFirst, which
-- would then return whichever the planner picked — a college's branding, attendance
-- bands or progression thresholds becoming a coin toss between two rows. That is
-- exactly the failure the singleton exists to prevent, reintroduced by the fix for
-- it.
--
-- Safe because each table holds at most one row per institution and the guard above
-- has already established there is at most one institution: at most one row each, so
-- no primary key can collide. Nothing references these ids as a foreign key.
UPDATE "Tenant"                  SET "id" = 'singleton';
UPDATE "TenantBranding"          SET "id" = 'singleton';
UPDATE "AttendanceBandConfig"    SET "id" = 'singleton';
UPDATE "PredictionModelSettings" SET "id" = 'singleton';
UPDATE "AttendanceTapConfig"     SET "id" = 'singleton';
UPDATE "TimetableSettings"       SET "id" = 'singleton';

-- And the column defaults themselves, so a row created AFTER this migration also
-- lands on the constant. Renumbering without this fixes today's row and leaves the
-- next insert to generate a cuid again.
ALTER TABLE "TimetableSettings" ALTER COLUMN "id" SET DEFAULT 'singleton';
ALTER TABLE "Tenant" ALTER COLUMN "id" SET DEFAULT 'singleton';

-- A SIXTH table, AttendanceEmailConfig, also carries @default('singleton') in the
-- schema and is deliberately absent from the renumbering above. It has held that
-- literal since 0_init created the column with it; the per-tenant migration only
-- changed its PRIMARY KEY, never the value. Said here because an auditor checking
-- "every singleton table was renumbered" will otherwise find a sixth and no reason.

-- DropForeignKey
ALTER TABLE "Adjustment" DROP CONSTRAINT "Adjustment_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Admission" DROP CONSTRAINT "Admission_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AdmissionCourse" DROP CONSTRAINT "AdmissionCourse_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AdmissionDocument" DROP CONSTRAINT "AdmissionDocument_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AdmissionIntake" DROP CONSTRAINT "AdmissionIntake_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Assessment" DROP CONSTRAINT "Assessment_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AssessmentAdjustment" DROP CONSTRAINT "AssessmentAdjustment_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AssessmentGrade" DROP CONSTRAINT "AssessmentGrade_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AssessmentSubmission" DROP CONSTRAINT "AssessmentSubmission_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AttendanceBandConfig" DROP CONSTRAINT "AttendanceBandConfig_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AttendanceEmailConfig" DROP CONSTRAINT "AttendanceEmailConfig_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AttendanceMark" DROP CONSTRAINT "AttendanceMark_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AttendanceTag" DROP CONSTRAINT "AttendanceTag_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AttendanceTapConfig" DROP CONSTRAINT "AttendanceTapConfig_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "CheckIn" DROP CONSTRAINT "CheckIn_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Cohort" DROP CONSTRAINT "Cohort_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Course" DROP CONSTRAINT "Course_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceToken" DROP CONSTRAINT "DeviceToken_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Document" DROP CONSTRAINT "Document_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Enrolment" DROP CONSTRAINT "Enrolment_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "EventCategory" DROP CONSTRAINT "EventCategory_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "HndSession" DROP CONSTRAINT "HndSession_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Interaction" DROP CONSTRAINT "Interaction_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Intervention" DROP CONSTRAINT "Intervention_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Ism" DROP CONSTRAINT "Ism_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Leave" DROP CONSTRAINT "Leave_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "MitigatingCircumstance" DROP CONSTRAINT "MitigatingCircumstance_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "MoodleSync" DROP CONSTRAINT "MoodleSync_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "PasswordReset" DROP CONSTRAINT "PasswordReset_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "PredictionModelSettings" DROP CONSTRAINT "PredictionModelSettings_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Room" DROP CONSTRAINT "Room_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Semester" DROP CONSTRAINT "Semester_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "SentNotification" DROP CONSTRAINT "SentNotification_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "SignupRequest" DROP CONSTRAINT "SignupRequest_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "SlcApplication" DROP CONSTRAINT "SlcApplication_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Staff" DROP CONSTRAINT "Staff_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "StaffReview" DROP CONSTRAINT "StaffReview_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Student" DROP CONSTRAINT "Student_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "StudentOutcome" DROP CONSTRAINT "StudentOutcome_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "StudentPredictionCurrent" DROP CONSTRAINT "StudentPredictionCurrent_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "StudentPredictionHistory" DROP CONSTRAINT "StudentPredictionHistory_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "StudentQuery" DROP CONSTRAINT "StudentQuery_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "StudentReview" DROP CONSTRAINT "StudentReview_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TagTap" DROP CONSTRAINT "TagTap_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TenantBranding" DROP CONSTRAINT "TenantBranding_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TenantDocTemplate" DROP CONSTRAINT "TenantDocTemplate_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TenantEmailTemplate" DROP CONSTRAINT "TenantEmailTemplate_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TenantIntegration" DROP CONSTRAINT "TenantIntegration_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Term" DROP CONSTRAINT "Term_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TermCalendar" DROP CONSTRAINT "TermCalendar_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TimesheetEntry" DROP CONSTRAINT "TimesheetEntry_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TimetableEvent" DROP CONSTRAINT "TimetableEvent_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TimetableEventGroup" DROP CONSTRAINT "TimetableEventGroup_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TimetableEventStaff" DROP CONSTRAINT "TimetableEventStaff_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TimetableSettings" DROP CONSTRAINT "TimetableSettings_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TimetableSlot" DROP CONSTRAINT "TimetableSlot_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TimetableUserPref" DROP CONSTRAINT "TimetableUserPref_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Unit" DROP CONSTRAINT "Unit_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "VleEngagement" DROP CONSTRAINT "VleEngagement_tenantId_fkey";

-- DropIndex
DROP INDEX "Adjustment_tenantId_idx";

-- DropIndex
DROP INDEX "Admission_tenantId_idx";

-- DropIndex
DROP INDEX "AdmissionCourse_tenantId_idx";

-- DropIndex
DROP INDEX "AdmissionDocument_tenantId_idx";

-- DropIndex
DROP INDEX "AdmissionIntake_tenantId_idx";

-- DropIndex
DROP INDEX "Assessment_tenantId_idx";

-- DropIndex
DROP INDEX "Assessment_tenantId_moodleItemId_key";

-- DropIndex
DROP INDEX "AssessmentAdjustment_tenantId_idx";

-- DropIndex
DROP INDEX "AssessmentGrade_tenantId_idx";

-- DropIndex
DROP INDEX "AssessmentSubmission_tenantId_idx";

-- DropIndex
DROP INDEX "AttendanceBandConfig_tenantId_key";

-- DropIndex
DROP INDEX "AttendanceEmailConfig_tenantId_idx";

-- DropIndex
DROP INDEX "AttendanceMark_tenantId_idx";

-- DropIndex
DROP INDEX "AttendanceTag_tenantId_idx";

-- DropIndex
DROP INDEX "AttendanceTapConfig_tenantId_key";

-- DropIndex
DROP INDEX "AuditLog_tenantId_action_idx";

-- DropIndex
DROP INDEX "AuditLog_tenantId_actorId_idx";

-- DropIndex
DROP INDEX "AuditLog_tenantId_at_idx";

-- DropIndex
DROP INDEX "AuditLog_tenantId_entity_entityId_idx";

-- DropIndex
DROP INDEX "CheckIn_tenantId_idx";

-- DropIndex
DROP INDEX "Cohort_tenantId_idx";

-- DropIndex
DROP INDEX "Course_tenantId_idx";

-- DropIndex
DROP INDEX "Course_tenantId_moodleCourseId_key";

-- DropIndex
DROP INDEX "Course_tenantId_name_key";

-- DropIndex
DROP INDEX "DeviceToken_tenantId_idx";

-- DropIndex
DROP INDEX "DeviceToken_tenantId_token_key";

-- DropIndex
DROP INDEX "Document_tenantId_idx";

-- DropIndex
DROP INDEX "Enrolment_tenantId_idx";

-- DropIndex
DROP INDEX "EventCategory_tenantId_active_idx";

-- DropIndex
DROP INDEX "EventCategory_tenantId_idx";

-- DropIndex
DROP INDEX "EventCategory_tenantId_name_key";

-- DropIndex
DROP INDEX "HndSession_tenantId_idx";

-- DropIndex
DROP INDEX "HndSession_tenantId_moodleSessionId_key";

-- DropIndex
DROP INDEX "Interaction_tenantId_idx";

-- DropIndex
DROP INDEX "Intervention_tenantId_idx";

-- DropIndex
DROP INDEX "Ism_tenantId_idx";

-- DropIndex
DROP INDEX "Leave_tenantId_idx";

-- DropIndex
DROP INDEX "MitigatingCircumstance_tenantId_idx";

-- DropIndex
DROP INDEX "MoodleSync_tenantId_idx";

-- DropIndex
DROP INDEX "Notification_tenantId_idx";

-- DropIndex
DROP INDEX "PasswordReset_tenantId_idx";

-- DropIndex
DROP INDEX "PredictionModelSettings_tenantId_key";

-- DropIndex
DROP INDEX "Room_tenantId_active_idx";

-- DropIndex
DROP INDEX "Room_tenantId_idx";

-- DropIndex
DROP INDEX "Room_tenantId_name_campus_key";

-- DropIndex
DROP INDEX "Semester_tenantId_idx";

-- DropIndex
DROP INDEX "SentNotification_tenantId_idx";

-- DropIndex
DROP INDEX "SignupRequest_tenantId_email_key";

-- DropIndex
DROP INDEX "SignupRequest_tenantId_idx";

-- DropIndex
DROP INDEX "SlcApplication_tenantId_idx";

-- DropIndex
DROP INDEX "Staff_tenantId_email_key";

-- DropIndex
DROP INDEX "Staff_tenantId_idx";

-- DropIndex
DROP INDEX "StaffReview_tenantId_idx";

-- DropIndex
DROP INDEX "Student_tenantId_email_key";

-- DropIndex
DROP INDEX "Student_tenantId_idx";

-- DropIndex
DROP INDEX "Student_tenantId_moodleUserId_key";

-- DropIndex
DROP INDEX "Student_tenantId_studentRef_key";

-- DropIndex
DROP INDEX "StudentOutcome_tenantId_idx";

-- DropIndex
DROP INDEX "StudentPredictionCurrent_tenantId_idx";

-- DropIndex
DROP INDEX "StudentPredictionHistory_tenantId_idx";

-- DropIndex
DROP INDEX "StudentQuery_tenantId_idx";

-- DropIndex
DROP INDEX "StudentReview_tenantId_idx";

-- DropIndex
DROP INDEX "TagTap_tenantId_idx";

-- DropIndex
DROP INDEX "TenantBranding_tenantId_key";

-- DropIndex
DROP INDEX "TenantDocTemplate_tenantId_idx";

-- DropIndex
DROP INDEX "TenantDocTemplate_tenantId_kind_key";

-- DropIndex
DROP INDEX "TenantEmailTemplate_tenantId_idx";

-- DropIndex
DROP INDEX "TenantEmailTemplate_tenantId_kind_key";

-- DropIndex
DROP INDEX "TenantIntegration_tenantId_idx";

-- DropIndex
DROP INDEX "TenantIntegration_tenantId_provider_key";

-- DropIndex
DROP INDEX "Term_tenantId_idx";

-- DropIndex
DROP INDEX "TermCalendar_tenantId_idx";

-- DropIndex
DROP INDEX "TimesheetEntry_tenantId_idx";

-- DropIndex
DROP INDEX "TimetableEvent_tenantId_date_idx";

-- DropIndex
DROP INDEX "TimetableEvent_tenantId_idx";

-- DropIndex
DROP INDEX "TimetableEventGroup_tenantId_idx";

-- DropIndex
DROP INDEX "TimetableEventStaff_tenantId_idx";

-- DropIndex
DROP INDEX "TimetableSettings_tenantId_idx";

-- DropIndex
DROP INDEX "TimetableSettings_tenantId_key";

-- DropIndex
DROP INDEX "TimetableSlot_tenantId_idx";

-- DropIndex
DROP INDEX "TimetableUserPref_tenantId_idx";

-- DropIndex
DROP INDEX "TimetableUserPref_tenantId_staffId_key";

-- DropIndex
DROP INDEX "Unit_tenantId_idx";

-- DropIndex
DROP INDEX "VleEngagement_tenantId_idx";

-- AlterTable
ALTER TABLE "Adjustment" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "Admission" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "AdmissionCourse" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "AdmissionDocument" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "AdmissionIntake" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "Assessment" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "AssessmentAdjustment" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "AssessmentGrade" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "AssessmentSubmission" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "AttendanceBandConfig" DROP COLUMN "tenantId",
ALTER COLUMN "id" SET DEFAULT 'singleton';

-- AlterTable
ALTER TABLE "AttendanceEmailConfig" DROP CONSTRAINT "AttendanceEmailConfig_pkey",
DROP COLUMN "tenantId",
ADD CONSTRAINT "AttendanceEmailConfig_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "AttendanceMark" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "AttendanceTag" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "AttendanceTapConfig" DROP COLUMN "tenantId",
ALTER COLUMN "id" SET DEFAULT 'singleton';

-- AlterTable
ALTER TABLE "AuditLog" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "CheckIn" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "Cohort" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "Course" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "DeviceToken" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "Document" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "Enrolment" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "EventCategory" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "HndSession" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "Interaction" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "Intervention" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "Ism" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "Leave" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "MitigatingCircumstance" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "MoodleSync" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "Notification" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "PasswordReset" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "PredictionModelSettings" DROP COLUMN "tenantId",
ALTER COLUMN "id" SET DEFAULT 'singleton';

-- AlterTable
ALTER TABLE "Room" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "Semester" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "SentNotification" DROP CONSTRAINT "SentNotification_pkey",
DROP COLUMN "tenantId",
ADD CONSTRAINT "SentNotification_pkey" PRIMARY KEY ("key");

-- AlterTable
ALTER TABLE "SignupRequest" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "SlcApplication" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "Staff" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "StaffReview" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "Student" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "StudentOutcome" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "StudentPredictionCurrent" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "StudentPredictionHistory" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "StudentQuery" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "StudentReview" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "TagTap" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "TenantBranding" DROP COLUMN "tenantId",
ALTER COLUMN "id" SET DEFAULT 'singleton';

-- AlterTable
ALTER TABLE "TenantDocTemplate" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "TenantEmailTemplate" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "TenantIntegration" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "Term" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "TermCalendar" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "TimesheetEntry" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "TimetableEvent" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "TimetableEventGroup" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "TimetableEventStaff" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "TimetableSettings" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "TimetableSlot" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "TimetableUserPref" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "Unit" DROP COLUMN "tenantId";

-- AlterTable
ALTER TABLE "VleEngagement" DROP COLUMN "tenantId";

-- DropTable
DROP TABLE "CollegeRegistration";

-- DropTable
DROP TABLE "PlatformAdmin";

-- CreateIndex
CREATE UNIQUE INDEX "Assessment_moodleItemId_key" ON "Assessment"("moodleItemId");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE UNIQUE INDEX "Course_name_key" ON "Course"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Course_moodleCourseId_key" ON "Course"("moodleCourseId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_token_key" ON "DeviceToken"("token");

-- CreateIndex
CREATE INDEX "EventCategory_active_idx" ON "EventCategory"("active");

-- CreateIndex
CREATE UNIQUE INDEX "EventCategory_name_key" ON "EventCategory"("name");

-- CreateIndex
CREATE UNIQUE INDEX "HndSession_moodleSessionId_key" ON "HndSession"("moodleSessionId");

-- CreateIndex
CREATE INDEX "Room_active_idx" ON "Room"("active");

-- CreateIndex
CREATE UNIQUE INDEX "Room_name_campus_key" ON "Room"("name", "campus");

-- CreateIndex
CREATE UNIQUE INDEX "SignupRequest_email_key" ON "SignupRequest"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Staff_email_key" ON "Staff"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Student_moodleUserId_key" ON "Student"("moodleUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Student_studentRef_key" ON "Student"("studentRef");

-- CreateIndex
CREATE UNIQUE INDEX "Student_email_key" ON "Student"("email");

-- CreateIndex
CREATE UNIQUE INDEX "TenantDocTemplate_kind_key" ON "TenantDocTemplate"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "TenantEmailTemplate_kind_key" ON "TenantEmailTemplate"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "TenantIntegration_provider_key" ON "TenantIntegration"("provider");

-- CreateIndex
CREATE INDEX "TimetableEvent_date_idx" ON "TimetableEvent"("date");

-- CreateIndex
CREATE UNIQUE INDEX "TimetableUserPref_staffId_key" ON "TimetableUserPref"("staffId");

