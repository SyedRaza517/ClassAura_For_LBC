-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "academicDepartmentId" TEXT,
ADD COLUMN     "vleCategoryExternalId" TEXT,
ADD COLUMN     "vleCategoryName" TEXT;

-- AlterTable
ALTER TABLE "Staff" ADD COLUMN     "collegeWide" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "academicDepartmentId" TEXT;

-- CreateTable
CREATE TABLE "AcademicDepartment" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "colour" TEXT NOT NULL DEFAULT '#1a3a8f',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademicDepartment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffAcademicDepartment" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "academicDepartmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffAcademicDepartment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AcademicDepartment_key_key" ON "AcademicDepartment"("key");

-- CreateIndex
CREATE INDEX "AcademicDepartment_active_idx" ON "AcademicDepartment"("active");

-- CreateIndex
CREATE INDEX "StaffAcademicDepartment_academicDepartmentId_idx" ON "StaffAcademicDepartment"("academicDepartmentId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffAcademicDepartment_staffId_academicDepartmentId_key" ON "StaffAcademicDepartment"("staffId", "academicDepartmentId");

-- CreateIndex
CREATE INDEX "Course_academicDepartmentId_idx" ON "Course"("academicDepartmentId");

-- CreateIndex
CREATE INDEX "Course_vleCategoryExternalId_idx" ON "Course"("vleCategoryExternalId");

-- CreateIndex
CREATE INDEX "Student_academicDepartmentId_idx" ON "Student"("academicDepartmentId");

-- AddForeignKey
ALTER TABLE "Course" ADD CONSTRAINT "Course_academicDepartmentId_fkey" FOREIGN KEY ("academicDepartmentId") REFERENCES "AcademicDepartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_academicDepartmentId_fkey" FOREIGN KEY ("academicDepartmentId") REFERENCES "AcademicDepartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAcademicDepartment" ADD CONSTRAINT "StaffAcademicDepartment_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAcademicDepartment" ADD CONSTRAINT "StaffAcademicDepartment_academicDepartmentId_fkey" FOREIGN KEY ("academicDepartmentId") REFERENCES "AcademicDepartment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------
-- Every staff account that exists at this moment becomes college-wide.
--
-- THE DEPLOY FAILS OPEN, LOUDLY, AND THAT IS THE DELIBERATE CHOICE. The alternative
-- locks the entire college out of every student mid-term for a change that is otherwise
-- invisible to them -- the same reasoning CLAUDE.md gives for IGNORING rather than
-- rejecting the stale `tid` claim after de-tenanting. Mitigation is visibility, not
-- tightening: the Departments screen carries a permanent "N of M staff have college-wide
-- access" line, so the state is never silent.
UPDATE "Staff" SET "collegeWide" = true;

-- NOTHING ELSE IS BACKFILLED. No department is created, and no Course or Student is
-- assigned one.
--
-- Seeding a "General" department and putting every course in it looks tidier and is a
-- silent fail-open: the first time the college narrows somebody off college-wide, that
-- person is scoped to a department containing the entire institution, and the screen
-- tells them nothing is wrong. Leaving everything unassigned inverts it -- a newly
-- scoped account sees NOTHING until departments are genuinely set up, which is loud and
-- safe. serializers.js already states this rule for parseAdminPages: "An admin who
-- suddenly has no pages is a loud, safe failure; an admin who suddenly has all of them
-- is a silent, dangerous one."
--
-- It also avoids minting a department whose `key` is immutable and immediately wrong the
-- moment the college renames it to "Business".
