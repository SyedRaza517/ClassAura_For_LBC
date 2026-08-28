-- Linking the financial and admissions records to the students they are about.
--
-- SlcApplication and Admission hold the withdrawal causes no academic metric can see —
-- loan status, days stalled awaiting evidence, a declined application, an identity
-- document about to expire — and neither has ever had a way to say WHICH STUDENT.
-- SlcApplication carried only an optional admissionId and a free-text studentRef;
-- Admission carried a column called studentId that is a college number an admin TYPED,
-- not a reference to anything.
--
-- This adds the way. It deliberately does NOT populate it: the backfill is a separate,
-- dry-run-first, human-read step, because a WRONG match attaches one student loan
-- status or document expiry to another person. That is inaccurate personal data about
-- an identified individual, concerning finance and immigration, driving a score staff
-- act on. It is an incident, not a bug you fix next sprint.
--
-- EVERY COLUMN NULLABLE, BY DESIGN. Both tables hold rows for people who are not
-- students: you apply for a loan before you enrol, and most applicants never enrol at
-- all. A NOT NULL column would force the backfill to invent a link for every row.
--
-- NO UNIQUE CONSTRAINT. A student legitimately has two SLC rows (a tuition loan and a
-- maintenance loan; a resubmission after a decline) and can have two admissions
-- (rejected in September, readmitted in January). A unique index would fail on correct
-- data and push somebody into deleting a real record to satisfy it.
--
-- ON DELETE SET NULL, NOT CASCADE. These are SOURCE records under a different
-- retention schedule from the academic record — a finance office does not lose its SLC
-- audit trail because a student row was tidied away. Same reasoning as Ism.admissionId
-- and Student.cohortId. Deliberately UNLIKE StudentPredictionHistory, which cascades
-- because it is a DERIVED behavioural profile and an erasure leaving one behind would
-- not be an erasure.
--
-- A single-column FK cannot enforce same-tenant. db.js prevents it on every request
-- path, but a backfill running raw SQL bypasses that, so every backfill statement joins
-- on tenantId explicitly and the tools script runs this check afterwards:
--
--   SELECT s.id FROM "SlcApplication" s JOIN "Student" st ON st.id = s."studentId"
--    WHERE st."tenantId" <> s."tenantId"
--   UNION ALL
--   SELECT a.id FROM "Admission" a JOIN "Student" st ON st.id = a."linkedStudentId"
--    WHERE st."tenantId" <> a."tenantId";
--
-- It must return zero rows on both databases.

ALTER TABLE "SlcApplication" ADD COLUMN "studentId"         TEXT;
ALTER TABLE "SlcApplication" ADD COLUMN "studentLinkSource" TEXT;
ALTER TABLE "SlcApplication" ADD COLUMN "studentLinkedAt"   TIMESTAMP(3);

-- The date `status` last actually changed. NOT derivable from updatedAt, which moves
-- when somebody corrects a typo in `notes`. Left NULL on every existing row and never
-- guessed backwards — it starts being true at the next real status change.
ALTER TABLE "SlcApplication" ADD COLUMN "statusChangedOn"   TEXT;

CREATE INDEX "SlcApplication_studentId_idx" ON "SlcApplication"("studentId");

ALTER TABLE "SlcApplication"
  ADD CONSTRAINT "SlcApplication_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- NOTE THE COLUMN NAME. Admission already has a "studentId" — a free-text college ID an
-- admin types, which admissionDocs.js uses to name the SharePoint folder. It is a
-- LABEL, not a reference. Hence linkedStudentId.
ALTER TABLE "Admission" ADD COLUMN "linkedStudentId"   TEXT;
ALTER TABLE "Admission" ADD COLUMN "studentLinkSource" TEXT;
ALTER TABLE "Admission" ADD COLUMN "studentLinkedAt"   TIMESTAMP(3);

-- The parsed form of idDateOfExpiry. Every consumer reads this and never the free-text
-- column, which is never overwritten: it is what the person typed, and that is a record.
ALTER TABLE "Admission" ADD COLUMN "idExpiryOn"     TEXT;
ALTER TABLE "Admission" ADD COLUMN "idExpiryStatus" TEXT;

CREATE INDEX "Admission_linkedStudentId_idx" ON "Admission"("linkedStudentId");
-- Partial: the quarantine queue asks only for the rows that need a human.
CREATE INDEX "Admission_idExpiryStatus_idx" ON "Admission"("idExpiryStatus")
  WHERE "idExpiryStatus" IS NOT NULL AND "idExpiryStatus" <> 'parsed';

ALTER TABLE "Admission"
  ADD CONSTRAINT "Admission_linkedStudentId_fkey"
  FOREIGN KEY ("linkedStudentId") REFERENCES "Student"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
