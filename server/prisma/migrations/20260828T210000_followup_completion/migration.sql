-- Recording that a promised follow-up HAPPENED.
--
-- Interaction.followUpRequired/followUpDate and StudentReview.followUp/followUpDate
-- recorded that a follow-up was PROMISED. Nothing recorded that one was kept, and both
-- routes nulled the date whenever the flag was cleared -- so the only way to close a
-- follow-up also destroyed the evidence that one had been due. "Overdue" had to be
-- inferred as followUpDate < today, which is true for ever, for every follow-up,
-- including the ones held on the morning they fell due.
--
-- ADDITIVE ONLY. Nothing is dropped, nothing is backfilled, no existing value changes.
--
-- WHAT NULL MEANS ON AN EXISTING ROW, AND WHAT IT MUST NOT MEAN.
--
-- Every row that already exists gets NULL here, and NULL must NOT read as "this
-- follow-up never happened" -- before this migration it could not have been recorded.
-- Reading it that way would light up every historic follow-up in the college on the day
-- this deploys: the same monotonic accumulation the column exists to end, delivered as
-- a one-time flood instead of a permanent slope.
--
-- There is deliberately NO backfill and NO stamped cut-over date. A backfill would
-- invent a completion nobody performed. A hardcoded date would be a DEPLOY date, and
-- the two databases are migrated on different days, so a constant right for one would
-- be silently wrong for the other. Instead prediction/metrics.js derives the boundary
-- from the data itself -- the earliest followUpCompletedOn recorded anywhere in the
-- college -- and reports null until one exists, exactly as latenessRate is null at a
-- college whose register has no "L".
--
-- DATES, NOT BOOLEANS. A follow-up promised for 1 March and held on 30 April happened,
-- and the gap is the part worth seeing. A boolean discards it irrecoverably.

ALTER TABLE "Interaction"   ADD COLUMN "followUpCompletedOn" TEXT;
ALTER TABLE "Interaction"   ADD COLUMN "followUpCompletedBy" TEXT;

ALTER TABLE "StudentReview" ADD COLUMN "followUpCompletedOn" TEXT;
ALTER TABLE "StudentReview" ADD COLUMN "followUpCompletedBy" TEXT;

-- The tripwire figure, on BOTH prediction tables and identically nullable. A column
-- writable as the current score but not as history half-succeeds and loses the audit
-- trail; schema-contract.test.js asserts the pair.
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "overdueFollowUpCount" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "overdueFollowUpCount" INTEGER;
