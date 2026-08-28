-- The college's side of the conversation: questions nobody answered.
--
-- Nullable, and the null is load-bearing. 0 open queries means the college answered
-- everything this student asked, which is real news. NULL means they asked nothing —
-- or the college never presses Respond, because staff read queries in the app and
-- reply in person, in which case every query it has ever received sits at "open" for
-- ever and a count would report the workflow rather than anybody's wait.
--
-- A DATE, not a day count. Nothing here runs on a clock.
--
-- TRIP_CONTACT_DEFICIT deliberately gets NO column: it crosses the risk level with a
-- pastoral date and is computed in runner.js after score(), because the stored risk
-- level is the previous run's for everybody in the batch. Storing an input to it
-- here would invite somebody to compute it from the stale side.

ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "oldestOpenQueryOn" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "openQueryCount" INTEGER;

ALTER TABLE "StudentPredictionHistory" ADD COLUMN "oldestOpenQueryOn" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "openQueryCount" INTEGER;
