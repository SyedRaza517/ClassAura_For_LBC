-- CreateTable
CREATE TABLE "Staff" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "jobTitle" TEXT NOT NULL,
    "dept" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "dob" TEXT,
    "passwordHash" TEXT NOT NULL,
    "accountRole" TEXT NOT NULL DEFAULT 'STAFF',
    "site" TEXT,
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "adminPages" TEXT,
    "allowance" INTEGER NOT NULL DEFAULT 28,
    "initials" TEXT NOT NULL,
    "colour" TEXT NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "totpSecret" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mustSetupTotp" BOOLEAN NOT NULL DEFAULT false,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "pendingActivation" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceToken" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'unknown',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordReset" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'reset',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignupRequest" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'staff',
    "studentId" TEXT,
    "collegeId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "jobTitle" TEXT NOT NULL,
    "dept" TEXT NOT NULL,
    "site" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignupRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "link" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckIn" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "timeIn" TEXT NOT NULL,
    "timeOut" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "site" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Leave" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "start" TEXT NOT NULL,
    "end" TEXT NOT NULL,
    "days" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL DEFAULT '—',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedAt" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TEXT,
    "note" TEXT,

    CONSTRAINT "Leave_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Adjustment" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "date" TEXT NOT NULL,

    CONSTRAINT "Adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'all',
    "assignedToId" TEXT,
    "filePath" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "uploadedAt" TIMESTAMP(3),

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Semester" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start" TEXT NOT NULL,
    "end" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Semester_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "colour" TEXT NOT NULL DEFAULT '#1a3a8f',
    "moodleCourseId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableSlot" (
    "id" TEXT NOT NULL,
    "courseId" TEXT,
    "year" INTEGER,
    "termNumber" INTEGER,
    "unitId" TEXT,
    "day" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "lecturer" TEXT NOT NULL DEFAULT '',
    "room" TEXT NOT NULL DEFAULT '',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimetableSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TermCalendar" (
    "id" TEXT NOT NULL,
    "courseId" TEXT,
    "year" INTEGER,
    "termNumber" INTEGER,
    "startDate" TEXT,
    "endDate" TEXT,
    "weeks" JSONB NOT NULL DEFAULT '[]',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TermCalendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cohort" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "startDate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cohort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Term" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "index" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "start" TEXT NOT NULL,
    "end" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Term_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "moodleSectionId" INTEGER,
    "moodleCourseId" INTEGER,
    "unitNumber" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "tutor" TEXT NOT NULL DEFAULT '',
    "courseId" TEXT,
    "year" INTEGER,
    "termNumber" INTEGER,
    "startDate" TEXT,
    "endDate" TEXT,
    "submissionDate" TEXT,
    "tutorStaffId" TEXT,
    "cohortId" TEXT,
    "termId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assessment" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "moodleItemId" INTEGER,
    "moodleCmid" INTEGER,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'Assignment',
    "maxMarks" INTEGER NOT NULL DEFAULT 100,
    "weight" INTEGER NOT NULL DEFAULT 0,
    "dueDate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Assessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentGrade" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "marks" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "submittedAt" TEXT,
    "gradedOn" TEXT,
    "feedback" TEXT NOT NULL DEFAULT '',
    "gradedBy" TEXT,
    "gradedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssessmentGrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL,
    "moodleUserId" INTEGER,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "studentRef" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "dob" TEXT,
    "initials" TEXT NOT NULL,
    "colour" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "cohortId" TEXT,
    "passwordHash" TEXT,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentQuery" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "response" TEXT NOT NULL DEFAULT '',
    "respondedBy" TEXT,
    "respondedAt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Interaction" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "time" TEXT NOT NULL,
    "queryType" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "followUpActions" TEXT NOT NULL DEFAULT '',
    "followUpRequired" BOOLEAN NOT NULL DEFAULT false,
    "followUpDate" TEXT,
    "tutor" TEXT NOT NULL DEFAULT '',
    "loggedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Interaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrolment" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Enrolment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HndSession" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "audience" TEXT NOT NULL DEFAULT 'All students',
    "kind" TEXT NOT NULL DEFAULT '',
    "moodleSessionId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HndSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceMark" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "remark" TEXT NOT NULL DEFAULT '',
    "takenBy" TEXT,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceMark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimesheetEntry" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'campus',
    "title" TEXT NOT NULL,
    "unitId" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "submittedAt" TEXT,
    "reviewNote" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimesheetEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoodleSync" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "mode" TEXT NOT NULL DEFAULT 'manual',
    "startedBy" TEXT,
    "summary" TEXT NOT NULL DEFAULT '{}',
    "issues" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT,

    CONSTRAINT "MoodleSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffReview" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "term" TEXT NOT NULL DEFAULT '',
    "academicYear" TEXT NOT NULL DEFAULT '',
    "dateCompleted" TEXT,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "answers" TEXT NOT NULL DEFAULT '{}',
    "completedBy" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'admin',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentReview" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "unitId" TEXT,
    "staffId" TEXT,
    "staffName" TEXT NOT NULL DEFAULT '',
    "date" TEXT NOT NULL,
    "progress" TEXT NOT NULL,
    "concerns" TEXT NOT NULL DEFAULT '[]',
    "summary" TEXT NOT NULL DEFAULT '',
    "agreedActions" TEXT NOT NULL DEFAULT '',
    "followUp" BOOLEAN NOT NULL DEFAULT false,
    "followUpDate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Admission" (
    "id" TEXT NOT NULL,
    "course" TEXT,
    "intake" TEXT,
    "intakeYear" TEXT,
    "foundVia" TEXT,
    "classOption" TEXT,
    "firstName" TEXT,
    "middleName" TEXT,
    "surname" TEXT,
    "dob" TEXT,
    "gender" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "countryOfBirth" TEXT,
    "countryOfCitizenship" TEXT,
    "idDocNo" TEXT,
    "idDateOfIssue" TEXT,
    "idDateOfExpiry" TEXT,
    "idIssuingCountry" TEXT,
    "niNumber" TEXT,
    "houseNo" TEXT,
    "street" TEXT,
    "city" TEXT,
    "postCode" TEXT,
    "mailingAddress" TEXT,
    "emergencyName" TEXT,
    "emergencyPhone" TEXT,
    "emergencyRelationship" TEXT,
    "emergencyEmail" TEXT,
    "criminalConviction" TEXT,
    "criminalDetails" TEXT,
    "medicalConditions" TEXT,
    "medicalDetails" TEXT,
    "learningDifficulty" TEXT,
    "learningDetails" TEXT,
    "englishFirstLanguage" TEXT,
    "englishProof" TEXT,
    "englishProofOther" TEXT,
    "highestEducation" TEXT,
    "overseasQualification" TEXT,
    "appliedElsewhere" TEXT,
    "previousStudentFinance" TEXT,
    "previousFinanceDetails" TEXT,
    "fundingIntent" TEXT,
    "fundingOther" TEXT,
    "employmentStatus" TEXT,
    "employmentDetails" TEXT,
    "jobTitle" TEXT,
    "companyName" TEXT,
    "dateStarted" TEXT,
    "workedPast" TEXT,
    "workedPastDetails" TEXT,
    "ref1Name" TEXT,
    "ref1Contact" TEXT,
    "ref1Email" TEXT,
    "ref1Relationship" TEXT,
    "ref2Name" TEXT,
    "ref2Role" TEXT,
    "ref2Organisation" TEXT,
    "ref2Relationship" TEXT,
    "ethnicity" TEXT,
    "religion" TEXT,
    "signature" TEXT,
    "declarationDate" TEXT,
    "docsRequestedAt" TIMESTAMP(3),
    "uploadTokenHash" TEXT,
    "uploadTokenExpires" TIMESTAMP(3),
    "spFolderId" TEXT,
    "spFolderUrl" TEXT,
    "interviewStatus" TEXT,
    "enrollStatus" TEXT,
    "studentId" TEXT,
    "ismOutcome" TEXT,
    "offerStatus" TEXT,
    "offerSentAt" TIMESTAMP(3),
    "offerAcceptedAt" TIMESTAMP(3),
    "offerInductionDate" TEXT,
    "offerSignatoryName" TEXT,
    "offerTokenHash" TEXT,
    "passwordHash" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "applicationSubmittedAt" TIMESTAMP(3),
    "source" TEXT,
    "interviewInviteDate" TEXT,
    "interviewInviteTime" TEXT,
    "interviewInviteMode" TEXT,
    "interviewInviteLocation" TEXT,
    "interviewInviteLink" TEXT,
    "interviewInviteNote" TEXT,
    "interviewInviteSentAt" TIMESTAMP(3),
    "enrolInductionDate" TEXT,
    "enrolInductionTime" TEXT,
    "enrolEmailSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Admission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ism" (
    "id" TEXT NOT NULL,
    "admissionId" TEXT,
    "name" TEXT,
    "courseUnderstanding" TEXT,
    "lastStudied" TEXT,
    "independentLearning" TEXT,
    "educationExperience" TEXT,
    "strengthsWeaknesses" TEXT,
    "prioritiseWorkload" TEXT,
    "working" TEXT,
    "teamworkExample" TEXT,
    "wifiAccess" TEXT,
    "officeSkills" TEXT,
    "admitted" TEXT,
    "interviewerName" TEXT,
    "interviewDate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ism_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionDocument" (
    "id" TEXT NOT NULL,
    "admissionId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "spItemId" TEXT,
    "webUrl" TEXT,
    "storagePath" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" TIMESTAMP(3),
    "confirmedBy" TEXT,

    CONSTRAINT "AdmissionDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionCourse" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmissionCourse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionIntake" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmissionIntake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceEmailConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceEmailConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SentNotification" (
    "key" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SentNotification_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SlcApplication" (
    "id" TEXT NOT NULL,
    "admissionId" TEXT,
    "studentName" TEXT NOT NULL,
    "studentRef" TEXT NOT NULL DEFAULT '',
    "course" TEXT NOT NULL DEFAULT '',
    "intake" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'Not applied',
    "loanType" TEXT NOT NULL DEFAULT '',
    "crn" TEXT NOT NULL DEFAULT '',
    "applicationDate" TEXT,
    "decisionDate" TEXT,
    "amount" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlcApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Staff_email_key" ON "Staff"("email");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_token_key" ON "DeviceToken"("token");

-- CreateIndex
CREATE INDEX "DeviceToken_staffId_idx" ON "DeviceToken"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordReset_tokenHash_key" ON "PasswordReset"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordReset_staffId_idx" ON "PasswordReset"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "SignupRequest_email_key" ON "SignupRequest"("email");

-- CreateIndex
CREATE INDEX "SignupRequest_status_idx" ON "SignupRequest"("status");

-- CreateIndex
CREATE INDEX "Notification_staffId_read_idx" ON "Notification"("staffId", "read");

-- CreateIndex
CREATE UNIQUE INDEX "CheckIn_staffId_date_key" ON "CheckIn"("staffId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Course_name_key" ON "Course"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Course_moodleCourseId_key" ON "Course"("moodleCourseId");

-- CreateIndex
CREATE INDEX "TimetableSlot_courseId_year_termNumber_idx" ON "TimetableSlot"("courseId", "year", "termNumber");

-- CreateIndex
CREATE INDEX "TimetableSlot_unitId_idx" ON "TimetableSlot"("unitId");

-- CreateIndex
CREATE UNIQUE INDEX "TermCalendar_courseId_year_termNumber_key" ON "TermCalendar"("courseId", "year", "termNumber");

-- CreateIndex
CREATE INDEX "Cohort_courseId_idx" ON "Cohort"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "Cohort_courseId_name_key" ON "Cohort"("courseId", "name");

-- CreateIndex
CREATE INDEX "Term_cohortId_idx" ON "Term"("cohortId");

-- CreateIndex
CREATE UNIQUE INDEX "Term_cohortId_year_index_key" ON "Term"("cohortId", "year", "index");

-- CreateIndex
CREATE INDEX "Unit_courseId_idx" ON "Unit"("courseId");

-- CreateIndex
CREATE INDEX "Unit_cohortId_idx" ON "Unit"("cohortId");

-- CreateIndex
CREATE INDEX "Unit_termId_idx" ON "Unit"("termId");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_courseId_code_key" ON "Unit"("courseId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Assessment_moodleItemId_key" ON "Assessment"("moodleItemId");

-- CreateIndex
CREATE INDEX "Assessment_unitId_idx" ON "Assessment"("unitId");

-- CreateIndex
CREATE INDEX "AssessmentGrade_studentId_idx" ON "AssessmentGrade"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentGrade_assessmentId_studentId_key" ON "AssessmentGrade"("assessmentId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "Student_moodleUserId_key" ON "Student"("moodleUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Student_studentRef_key" ON "Student"("studentRef");

-- CreateIndex
CREATE UNIQUE INDEX "Student_email_key" ON "Student"("email");

-- CreateIndex
CREATE INDEX "Student_cohortId_idx" ON "Student"("cohortId");

-- CreateIndex
CREATE INDEX "StudentQuery_studentId_idx" ON "StudentQuery"("studentId");

-- CreateIndex
CREATE INDEX "StudentQuery_status_idx" ON "StudentQuery"("status");

-- CreateIndex
CREATE INDEX "Interaction_studentId_idx" ON "Interaction"("studentId");

-- CreateIndex
CREATE INDEX "Interaction_followUpRequired_idx" ON "Interaction"("followUpRequired");

-- CreateIndex
CREATE INDEX "Enrolment_unitId_idx" ON "Enrolment"("unitId");

-- CreateIndex
CREATE UNIQUE INDEX "Enrolment_studentId_unitId_key" ON "Enrolment"("studentId", "unitId");

-- CreateIndex
CREATE UNIQUE INDEX "HndSession_moodleSessionId_key" ON "HndSession"("moodleSessionId");

-- CreateIndex
CREATE INDEX "HndSession_unitId_date_idx" ON "HndSession"("unitId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "HndSession_unitId_date_startTime_key" ON "HndSession"("unitId", "date", "startTime");

-- CreateIndex
CREATE INDEX "AttendanceMark_studentId_idx" ON "AttendanceMark"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceMark_sessionId_studentId_key" ON "AttendanceMark"("sessionId", "studentId");

-- CreateIndex
CREATE INDEX "TimesheetEntry_staffId_date_idx" ON "TimesheetEntry"("staffId", "date");

-- CreateIndex
CREATE INDEX "TimesheetEntry_staffId_status_idx" ON "TimesheetEntry"("staffId", "status");

-- CreateIndex
CREATE INDEX "MoodleSync_startedAt_idx" ON "MoodleSync"("startedAt");

-- CreateIndex
CREATE INDEX "StaffReview_staffId_idx" ON "StaffReview"("staffId");

-- CreateIndex
CREATE INDEX "StaffReview_type_idx" ON "StaffReview"("type");

-- CreateIndex
CREATE INDEX "StaffReview_status_idx" ON "StaffReview"("status");

-- CreateIndex
CREATE INDEX "StudentReview_studentId_idx" ON "StudentReview"("studentId");

-- CreateIndex
CREATE INDEX "StudentReview_staffId_idx" ON "StudentReview"("staffId");

-- CreateIndex
CREATE INDEX "StudentReview_followUp_idx" ON "StudentReview"("followUp");

-- CreateIndex
CREATE INDEX "StudentReview_date_idx" ON "StudentReview"("date");

-- CreateIndex
CREATE UNIQUE INDEX "Admission_uploadTokenHash_key" ON "Admission"("uploadTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Admission_offerTokenHash_key" ON "Admission"("offerTokenHash");

-- CreateIndex
CREATE INDEX "Admission_surname_firstName_idx" ON "Admission"("surname", "firstName");

-- CreateIndex
CREATE INDEX "Ism_admissionId_idx" ON "Ism"("admissionId");

-- CreateIndex
CREATE INDEX "AdmissionDocument_admissionId_idx" ON "AdmissionDocument"("admissionId");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionDocument_admissionId_docType_key" ON "AdmissionDocument"("admissionId", "docType");

-- CreateIndex
CREATE INDEX "SlcApplication_status_idx" ON "SlcApplication"("status");

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordReset" ADD CONSTRAINT "PasswordReset_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Leave" ADD CONSTRAINT "Leave_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Adjustment" ADD CONSTRAINT "Adjustment_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSlot" ADD CONSTRAINT "TimetableSlot_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSlot" ADD CONSTRAINT "TimetableSlot_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TermCalendar" ADD CONSTRAINT "TermCalendar_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cohort" ADD CONSTRAINT "Cohort_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Term" ADD CONSTRAINT "Term_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_tutorStaffId_fkey" FOREIGN KEY ("tutorStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentGrade" ADD CONSTRAINT "AssessmentGrade_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentGrade" ADD CONSTRAINT "AssessmentGrade_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentQuery" ADD CONSTRAINT "StudentQuery_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrolment" ADD CONSTRAINT "Enrolment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrolment" ADD CONSTRAINT "Enrolment_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HndSession" ADD CONSTRAINT "HndSession_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceMark" ADD CONSTRAINT "AttendanceMark_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "HndSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceMark" ADD CONSTRAINT "AttendanceMark_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffReview" ADD CONSTRAINT "StaffReview_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentReview" ADD CONSTRAINT "StudentReview_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentReview" ADD CONSTRAINT "StudentReview_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentReview" ADD CONSTRAINT "StudentReview_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ism" ADD CONSTRAINT "Ism_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "Admission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionDocument" ADD CONSTRAINT "AdmissionDocument_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "Admission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

