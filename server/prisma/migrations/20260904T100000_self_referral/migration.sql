-- A student can ask Wellbeing or ASK for help themselves, rather than waiting for a
-- tutor to notice. Additive: one nullable-with-default boolean, so an older build keeps
-- serving while it is applied.
ALTER TABLE "Referral" ADD COLUMN     "selfReferred" BOOLEAN NOT NULL DEFAULT false;

-- Every referral that exists today was raised by a member of staff, which is what the
-- default already says. Stated rather than left implicit: a backfill that guessed
-- otherwise would rewrite history about who asked for help.
