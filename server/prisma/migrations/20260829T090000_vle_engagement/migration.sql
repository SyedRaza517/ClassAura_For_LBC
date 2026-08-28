-- VLE engagement: whether a student opened the course at all.
--
-- One new table and four nullable columns on each prediction table. Nothing existing is
-- altered, nothing is backfilled, and there is no history to reconstruct -- lastcourseaccess
-- is a scalar that has moved on by the next night, so a day not observed is missed FOR
-- EVER and must never be interpolated.
--
-- COSTS NO EXTRA MOODLE CALLS. core_enrol_get_enrolled_users is already issued once per
-- course by syncFromMoodle and lastcourseaccess is already in the response, being thrown
-- away. This captures what is already on the wire.
--
-- A ROW MEANS "WE LOOKED". An observed-but-inactive student gets accessed = false. A
-- student who could not be observed gets NO ROW. Absence is the null.
--
-- That encoding is not stylistic. Every other institution guard here works by counting:
-- zero "L" attendance marks college-wide can only mean the register has no lateness code,
-- because a college where nobody was ever late does not exist. Engagement breaks the
-- trick -- zero engagement across a college is exactly what a disengaged cohort looks
-- like, AND what a Moodle with $CFG->hiddenuserfields set looks like, AND what a college
-- that teaches face to face looks like. No count separates them, so the distinction is
-- recorded at the moment of the pull by the code that saw the HTTP response.
--
-- lastAccessOn is NULL where Moodle reported 0, which is its "never". Multiplying that by
-- 1000 and calling it a timestamp dates the student to 1 January 1970, and "twenty
-- thousand days since last access" sorts them straight to the top of every risk list.

CREATE TABLE "VleEngagement" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "observedOn" TEXT NOT NULL,
    "accessed" BOOLEAN NOT NULL,
    "lastAccessOn" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "VleEngagement_pkey" PRIMARY KEY ("id")
);

-- One observation per student per course per day. Re-running a sync on the same day
-- corrects the row rather than duplicating it, which matters because the sync is run by
-- hand and often more than once while somebody is watching it.
CREATE UNIQUE INDEX "VleEngagement_studentId_unitId_observedOn_key" ON "VleEngagement"("studentId", "unitId", "observedOn");

CREATE INDEX "VleEngagement_studentId_idx" ON "VleEngagement"("studentId");

CREATE INDEX "VleEngagement_observedOn_idx" ON "VleEngagement"("observedOn");

CREATE INDEX "VleEngagement_tenantId_idx" ON "VleEngagement"("tenantId");

ALTER TABLE "VleEngagement" ADD CONSTRAINT "VleEngagement_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VleEngagement" ADD CONSTRAINT "VleEngagement_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VleEngagement" ADD CONSTRAINT "VleEngagement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "vleLastAccessOn" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "vleActiveDayRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "vleObservedDays" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "vleUnitsObserved" INTEGER;

ALTER TABLE "StudentPredictionHistory" ADD COLUMN "vleLastAccessOn" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "vleActiveDayRate" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "vleObservedDays" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "vleUnitsObserved" INTEGER;
