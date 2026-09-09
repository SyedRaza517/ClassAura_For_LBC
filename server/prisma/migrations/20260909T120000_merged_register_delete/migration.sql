-- Deleting a merged class failed, and the register index is why.
--
-- THE FAILURE. DELETE /api/timetabling/events/:id on a class with two or more groups
-- answered 500. Postgres: `Unique constraint failed on the fields: (unitId, date,
-- startTime)`, P2002. Nothing was lost — the delete runs in a transaction and rolled
-- back cleanly, verified: the event survived, both registers survived, every attendance
-- mark survived — but the action was simply impossible, on the very feature the merged
-- register was built for.
--
-- WHY. HndSession.timetableEventId is SetNull, deliberately, so a register outlives the
-- timetable entry it came from. That means deleting an event MOVES its registers between
-- the two partial unique indexes 20260907T120000_timetabling_registers created:
--
--   HndSession_event_group_key  ("timetableEventId", COALESCE("cohortId",''))
--                               WHERE "timetableEventId" IS NOT NULL
--   HndSession_generated_key    ("unitId","date","startTime")
--                               WHERE "timetableEventId" IS NULL
--
-- A merged class keeps ONE REGISTER PER GROUP — that is the whole point of it — so its
-- registers are identical in unit, date and start time and differ ONLY by cohortId. The
-- linked index contains cohortId and permits them. The unlinked one does not, so the
-- moment SetNull drops them into it they collapse onto one key and collide with each
-- other. Two rows that were legal a microsecond earlier.
--
-- THE FIX is to give the unlinked index the same column the linked one already has, so
-- the two agree about what makes a register unique.
--
-- IT LOOSENS NOTHING. The guarantee HndSession_generated_key exists for is that a second
-- register-generation run cannot create a parallel set and silently double every
-- student's attendance denominator. Generated registers — from the Moodle import and the
-- three-hour-block generator — carry NO cohortId: verified before writing this, every
-- ungrouped row on the reference database has cohortId NULL. They therefore all COALESCE
-- to the same empty string and the constraint binds them exactly as before. What becomes
-- possible is only the case that was already legal while the event existed: two registers
-- for one module at one time, for DIFFERENT groups.
--
-- COALESCE, NOT A PLAIN FOUR-COLUMN INDEX, for the reason the sibling index states at
-- length: Postgres treats NULLs as distinct, so ("u1","2026-09-15","09:00",NULL) twice
-- would both be accepted and the duplicate-generation hole would reopen for exactly the
-- rows this index is meant to hold.
DROP INDEX "HndSession_generated_key";

CREATE UNIQUE INDEX "HndSession_generated_key"
  ON "HndSession" ("unitId", "date", "startTime", COALESCE("cohortId", ''))
  WHERE "timetableEventId" IS NULL;
