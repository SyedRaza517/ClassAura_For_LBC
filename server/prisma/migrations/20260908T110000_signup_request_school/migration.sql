-- A sign-up request gains the SCHOOL its applicant will be filed under on approval.
--
-- NULLABLE, WITH NO BACKFILL, AND THAT IS THE WHOLE SAFETY STORY OF THIS MIGRATION.
-- Every request already sitting in the queue was made without anybody being asked which
-- school the applicant belongs to. Defaulting them to one — the first row, an alphabetical
-- winner, a seeded "General" — would be inventing an answer to a question nobody put, and
-- approving that request would then grant a real department membership on the strength of
-- it. academicDepartments.js refuses to ship a default department for exactly this reason:
-- a fabricated assignment is worse than a missing one, because the screen stops saying
-- anything is wrong. NULL means "not asked", approval treats it as "no school chosen", and
-- the flow works precisely as it did the day before this ran.
--
-- A REAL FOREIGN KEY, SetNull, matching every other academicDepartmentId in this schema
-- (Course, Student, Unit, Cohort, TimetableSlot, TimetableEvent all use it). Deleting a
-- school clears the suggestion rather than leaving a dangling id for the approval handler
-- to guess about — and "the school is gone, so approve without one" is what SetNull
-- already says. NOT Cascade: a sign-up request is a record of somebody applying, and a
-- department being reorganised must not delete the evidence of who asked to join it.
--
-- Adding a nullable column, an index and a NOT VALID-free FK to a table that holds tens of
-- rows on the largest install: no rewrite, no lock worth naming, and nothing to undo if the
-- deploy is rolled back to a build that never reads the column.
ALTER TABLE "SignupRequest" ADD COLUMN "academicDepartmentId" TEXT;

-- Indexed like every other academicDepartmentId. The queue is small today, but the
-- ON DELETE SET NULL below has to find these rows whenever a school is deleted, and an
-- unindexed FK turns that into a sequential scan of the whole table inside the delete's
-- transaction.
CREATE INDEX "SignupRequest_academicDepartmentId_idx" ON "SignupRequest"("academicDepartmentId");

ALTER TABLE "SignupRequest"
  ADD CONSTRAINT "SignupRequest_academicDepartmentId_fkey"
  FOREIGN KEY ("academicDepartmentId") REFERENCES "AcademicDepartment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
