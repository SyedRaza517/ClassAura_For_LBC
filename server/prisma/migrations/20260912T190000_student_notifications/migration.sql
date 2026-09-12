-- Notification and DeviceToken gain a student owner, alongside the staff owner they have
-- always had, so the student app can persist its own notification feed and register its
-- own devices for push — the same two tables Staff already uses, widened rather than
-- duplicated into StudentNotification / StudentDeviceToken twins.
--
-- staffId DROPS NOT NULL rather than staying required. Every row written before this
-- migration is a staff notification or a staff device, and none of them change meaning:
-- DROP NOT NULL touches only the column's constraint, not a single existing value, so
-- every staff row that exists today reads back identically once this runs.
--
-- studentId is ADDED NULLABLE, with no backfill, for the same reason SignupRequest's
-- academicDepartmentId had none (20260908T110000_signup_request_school): there is
-- nothing to backfill it FROM. A staff notification has no student to attribute it to.
--
-- EXACTLY ONE OF THE TWO MUST EVER BE SET, and that is not left to route code to get
-- right. A row owned by nobody (both null) is unreadable — no query for "this staff
-- member's notifications" or "this student's notifications" would ever return it, so it
-- would sit in the table forever, uncounted and unreachable. A row owned by both (both
-- set) is worse: it would appear in a staff member's feed AND a student's feed, which is
-- exactly the cross-audience leak the two apps must never have between them. Prisma
-- cannot express "exactly one of these two columns is null" — there is no schema.prisma
-- syntax for a cross-column CHECK — so it is raw SQL here and a comment pointing at this
-- migration in the schema, the same arrangement as the two partial unique indexes on
-- HndSession that Prisma also cannot see (schema.prisma, that model's own comment).
ALTER TABLE "Notification" ALTER COLUMN "staffId" DROP NOT NULL;
ALTER TABLE "Notification" ADD COLUMN "studentId" TEXT;

ALTER TABLE "DeviceToken" ALTER COLUMN "staffId" DROP NOT NULL;
ALTER TABLE "DeviceToken" ADD COLUMN "studentId" TEXT;

-- Foreign keys, ON DELETE CASCADE — matching the existing staffId FKs on both tables.
-- A deleted student's notifications and registered devices are deleted with them, the
-- same as a deleted staff member's already are; there is no reason to keep either
-- around as an orphan once the person they belong to is gone.
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DeviceToken"
  ADD CONSTRAINT "DeviceToken_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexed like every other owner-lookup column in this schema: the student app's own
-- "my notifications" / "my registered devices" queries filter on studentId exactly as
-- the staff app already filters on staffId, and an unindexed column here would be a
-- sequential scan of the whole table on every screen load.
CREATE INDEX "Notification_studentId_read_idx" ON "Notification"("studentId", "read");
CREATE INDEX "DeviceToken_studentId_idx" ON "DeviceToken"("studentId");

-- THE INVARIANT ITSELF. Exactly one of staffId/studentId is non-null, on every row, in
-- both directions: `<>` is boolean XOR here (each side is true or false, never NULL,
-- because IS NULL always returns a definite boolean), so this is false — and the
-- INSERT/UPDATE is rejected — for the all-null row and for the both-set row alike, and
-- true for every legitimate staff-owned or student-owned row, old or new.
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_one_owner_check"
  CHECK (("staffId" IS NULL) <> ("studentId" IS NULL));

ALTER TABLE "DeviceToken"
  ADD CONSTRAINT "DeviceToken_one_owner_check"
  CHECK (("staffId" IS NULL) <> ("studentId" IS NULL));
