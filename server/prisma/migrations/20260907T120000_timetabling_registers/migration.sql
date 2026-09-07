-- Timetabling → registers, phase 1.
--
-- Three things happen here, and the ORDER matters in two places:
--
--   1. Campus becomes a table, and Room.campus's free text is folded into it. The
--      backfill must run BEFORE Room's new unique index, because the index is on
--      campusId and there is nothing to be unique about until the column is filled.
--   2. HndSession gains its link to a timetabled event, the group the register is for,
--      and the room.
--   3. HndSession's @@unique([unitId, date, startTime]) is replaced by TWO PARTIAL
--      indexes. This is the substantive change; see the block above them.
--
-- Additive except for the two dropped indexes. No data is deleted, and Room.campus is
-- deliberately kept — it is the only record of what the free text said if the fold
-- turns out to have been wrong.

-- ---------------------------------------------------------------- campus, as rows --

CREATE TABLE "Campus" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campus_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Campus_name_key" ON "Campus"("name");
CREATE INDEX "Campus_active_idx" ON "Campus"("active");

ALTER TABLE "Room" ADD COLUMN "campusId" TEXT;

-- One Campus per distinct case-insensitive, whitespace-normalised spelling.
--
-- The winning spelling is the most common one; ties break on `COLLATE "C"`, which sorts
-- uppercase before lowercase, so a college that wrote "Ealing" once and "ealing" once
-- gets "Ealing". This mirrors groupCampuses() in src/timetabling/campusMatch.js, which
-- uses { caseFirst: "upper" } for the same reason: a campus name is a proper noun on a
-- dropdown and "ealing" there reads as a fault.
--
-- Rooms with a blank campus are excluded, so they end with campusId NULL. "No campus
-- recorded" must not become membership of a campus called "".
INSERT INTO "Campus" ("id", "name", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, picked.name, NOW(), NOW()
FROM (
  SELECT DISTINCT ON (norm) name
  FROM (
    SELECT btrim(regexp_replace("campus", '\s+', ' ', 'g'))        AS name,
           lower(btrim(regexp_replace("campus", '\s+', ' ', 'g'))) AS norm,
           count(*)                                                AS n
    FROM "Room"
    WHERE btrim("campus") <> ''
    GROUP BY 1, 2
  ) spellings
  ORDER BY norm, n DESC, name COLLATE "C" ASC
) picked;

UPDATE "Room" r
SET "campusId" = c."id"
FROM "Campus" c
WHERE lower(btrim(regexp_replace(r."campus", '\s+', ' ', 'g'))) = lower(c."name");

-- RAISE BEFORE THE INDEX DOES, so the error names the rooms.
--
-- Under the old @@unique([name, campus]) a room "101" on "Ealing" and a room "101" on
-- "ealing" were two different rooms. Folding the spellings makes them the same room
-- twice, and the new unique index would refuse with a message naming only the
-- constraint. That leaves an administrator with a failed deploy and no idea which of
-- four thousand rooms to look at.
--
-- The fix when this fires is to merge or rename the rooms deliberately, then re-run.
-- It is never to weaken the check: two rooms with one name on one campus means every
-- future room booking is ambiguous.
DO $$
DECLARE dups TEXT;
BEGIN
  SELECT string_agg(format('%s (%s)', d.name, d.spellings), '; ' ORDER BY d.name)
  INTO dups
  FROM (
    SELECT "name", string_agg(DISTINCT "campus", ' / ') AS spellings
    FROM "Room"
    WHERE "campusId" IS NOT NULL
    GROUP BY "name", "campusId"
    HAVING count(*) > 1
  ) d;

  IF dups IS NOT NULL THEN
    RAISE EXCEPTION
      'Folding campus spellings together makes these rooms duplicates: %. Merge or rename them, then re-run this migration. Do not weaken the unique index — two rooms with one name on one campus make every future booking ambiguous.',
      dups;
  END IF;
END $$;

DROP INDEX "Room_name_campus_key";
CREATE INDEX "Room_campusId_idx" ON "Room"("campusId");
CREATE UNIQUE INDEX "Room_name_campusId_key" ON "Room"("name", "campusId");

-- ------------------------------------------------- the event/register link, columns --

ALTER TABLE "HndSession" ADD COLUMN     "cohortId" TEXT,
                         ADD COLUMN     "roomId" TEXT,
                         ADD COLUMN     "timetableEventId" TEXT;

ALTER TABLE "TimetableEvent" ADD COLUMN     "createRegisters" BOOLEAN NOT NULL DEFAULT true,
                             ADD COLUMN     "publishedAt" TIMESTAMP(3),
                             ADD COLUMN     "seriesId" TEXT;

CREATE INDEX "HndSession_timetableEventId_idx" ON "HndSession"("timetableEventId");
CREATE INDEX "HndSession_cohortId_idx" ON "HndSession"("cohortId");
CREATE INDEX "HndSession_roomId_idx" ON "HndSession"("roomId");
CREATE INDEX "TimetableEvent_seriesId_idx" ON "TimetableEvent"("seriesId");

-- ------------------------------------------------------ uniqueness, split in two --

-- HndSession carried @@unique([unitId, date, startTime]). It stopped a second register
-- generation run on a different weekday creating a whole parallel set — silently
-- doubling every attendance denominator — and stopped two concurrent runs creating
-- exact duplicates. That guarantee is NOT being relaxed; it is being narrowed to the
-- rows it still describes.
--
-- A MERGED CLASS legitimately needs two registers for one module at one start time,
-- one per group, and the old constraint forbade exactly that.
--
-- So: registers with no event keep the original rule, and registers built from an
-- event are identified by the event and the group instead.
DROP INDEX "HndSession_unitId_date_startTime_key";

CREATE UNIQUE INDEX "HndSession_generated_key"
  ON "HndSession" ("unitId", "date", "startTime")
  WHERE "timetableEventId" IS NULL;

-- COALESCE, NOT A PLAIN TWO-COLUMN INDEX. Postgres treats NULLs as distinct, so
-- ("evt1", NULL) and ("evt1", NULL) would both be accepted and an event with no group
-- could accumulate unlimited duplicate registers — reopening the exact hole the
-- original constraint existed to close.
CREATE UNIQUE INDEX "HndSession_event_group_key"
  ON "HndSession" ("timetableEventId", COALESCE("cohortId", ''))
  WHERE "timetableEventId" IS NOT NULL;

-- ------------------------------------------------------------------ foreign keys --

-- All SetNull. Deleting a timetable entry, a group or a room must never delete
-- attendance: the register survives, unlinked, and stays in the record the college is
-- asked to evidence.
ALTER TABLE "HndSession" ADD CONSTRAINT "HndSession_timetableEventId_fkey" FOREIGN KEY ("timetableEventId") REFERENCES "TimetableEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HndSession" ADD CONSTRAINT "HndSession_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HndSession" ADD CONSTRAINT "HndSession_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Room" ADD CONSTRAINT "Room_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE SET NULL ON UPDATE CASCADE;
