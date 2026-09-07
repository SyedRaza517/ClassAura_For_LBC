-- Rename the attendance-tags page key to attendance-settings.
--
-- WHY A DATA MIGRATION AND NOT JUST A CODE RENAME. Staff.adminPages is a JSON array of
-- page keys, and NULL there means "never configured -> full access". A non-null array is
-- an EXPLICIT grant list. Renaming the key in ADMIN_PAGES alone would leave every
-- explicitly-granted account holding a key that no longer exists, which requirePage reads
-- as "not granted" -- so the screen would silently disappear for exactly the
-- administrators who had been given it on purpose, and stay visible only for the
-- unconfigured accounts that see everything anyway. Precisely backwards.
--
-- A string replace on the QUOTED key is safe: page keys are lower-case, hyphenated, and
-- no key is a substring of another, while the quotes pin the match to a whole JSON
-- element rather than a fragment of a longer one. "attendance-tags" appears in no other
-- column.
--
-- Idempotent by construction: after this runs the old key is gone, so a second run
-- matches nothing.
UPDATE "Staff"
SET "adminPages" = replace("adminPages", '"attendance-tags"', '"attendance-settings"')
WHERE "adminPages" LIKE '%"attendance-tags"%';
