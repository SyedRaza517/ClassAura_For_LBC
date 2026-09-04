-- Staff.collegeWide now defaults to TRUE, and narrowing becomes the deliberate act.
--
-- WHY A SECOND MIGRATION RATHER THAN EDITING THE FIRST. 20260904T120000 has been applied,
-- and an applied migration is never edited or renamed on this project -- Prisma would see
-- it as new, re-run it, fail on objects that already exist, and then refuse every later
-- migration with P3009. That has happened twice here.
--
-- WHY THE DEFAULT CHANGES AT ALL. The first migration set collegeWide on every account
-- that existed AT THAT MOMENT, which says nothing about accounts created afterwards. With
-- a false default, a college part-way through spec 1 -- no departments configured yet --
-- would hand every newly created tutor an empty screen: no students, no courses, no
-- registers, and nothing explaining why. The foundation spec promises no behaviour change,
-- and that is a behaviour change.
--
-- Fail-open at the ACCOUNT level, which is the shape adminPages already has: NULL there
-- means "never configured -> full access, so existing admins are not locked out". The
-- boundary itself still fails CLOSED -- an account explicitly narrowed with no departments
-- sees nothing, and an unassigned course or student is visible only to college-wide staff.
--
-- It is not silent. The Departments screen carries a permanent "N of M staff have
-- college-wide access" line, which is the college's to-do list for narrowing people.
ALTER TABLE "Staff" ALTER COLUMN "collegeWide" SET DEFAULT true;

-- Accounts created BETWEEN the two migrations -- in practice the seeded fixtures, and any
-- account an administrator added in the window -- were created under the false default and
-- would otherwise be the only scoped-to-nothing accounts in the college.
UPDATE "Staff" SET "collegeWide" = true WHERE "collegeWide" = false;
