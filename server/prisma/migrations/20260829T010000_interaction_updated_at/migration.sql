-- Interaction had no updatedAt; StudentReview has had one since it was created.
--
-- This is not tidiness. The prediction layer needs to know when a follow-up COMPLETION
-- was first recorded anywhere in the college, and the completion DATE cannot answer
-- that: staff legitimately backdate it, because a follow-up promised for 1 March and
-- held on 30 April happened on 30 April. Deriving the watermark from the claimed date
-- meant one honest backdated entry would drag it months into the past and make every
-- untouched promise since then judgeable in a single run — the institution-wide flood
-- the watermark exists to prevent, arriving the moment somebody worked their backlog.
--
-- Existing rows are stamped with the migration time. That is the correct answer for
-- this purpose rather than a fudge: no row can have carried a completion before the
-- column that holds one existed, so the deploy moment IS a true lower bound.

ALTER TABLE "Interaction" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
