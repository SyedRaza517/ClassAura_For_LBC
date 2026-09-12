-- Engine review fix (Task 5/6): TimetableEvent.updatedAt is `@updatedAt`, so the very
-- write that stores teamsMeetingSyncedAt bumps updatedAt to a LATER instant than what
-- was just recorded. Comparing "updatedAt > teamsMeetingSyncedAt" as the patch gate
-- was therefore permanently true after the first sync — every owned meeting got
-- re-PATCHed on every single hourly tick forever, re-notifying every attendee each
-- time. A stored fingerprint of exactly the fields the PATCH body carries replaces
-- that comparison: it only changes when one of THOSE fields actually changes, so a
-- tick that finds nothing different computes the same string and skips the PATCH.
-- teamsMeetingSyncedAt stays, but only as an informational "last touched" timestamp.
ALTER TABLE "TimetableEvent" ADD COLUMN "teamsMeetingFingerprint" TEXT;

-- UnitChannel.channelEmail's own schema comment has always described three states —
-- "" (never fetched), an address (fetched), or null (fetched once, tenant has none) —
-- but the column carried no default, so a row inserted without naming a value landed
-- on NULL: indistinguishable from "confirmed no email" and never retried. The default
-- now matches what the comment already promised; existing rows are untouched (a bare
-- ALTER ... SET DEFAULT does not rewrite data already stored).
ALTER TABLE "UnitChannel" ALTER COLUMN "channelEmail" SET DEFAULT '';
