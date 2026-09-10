-- Where each campus is, for the check-in geofence.
--
-- All four columns are nullable and nothing is backfilled, deliberately. There is no
-- coordinate to guess: a campus name is not a location, and inventing one would put a
-- boundary somewhere nobody chose while the settings screen reported the geofence as
-- enforced. Until somebody stands on the campus and records it, the honest state is "we
-- do not know", and presence.js refuses a check-in against an unlocated campus rather
-- than passing it.
--
-- NULL, NEVER 0. Latitude 0, longitude 0 is a valid-looking coordinate in the Gulf of
-- Guinea, so a DEFAULT 0 would not read as missing — it would read as a campus 5,000 km
-- from here that every student is refused from, and the reason would take a long time to
-- find.
ALTER TABLE "Campus" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "Campus" ADD COLUMN "longitude" DOUBLE PRECISION;
ALTER TABLE "Campus" ADD COLUMN "locatedAt" TIMESTAMP(3);
ALTER TABLE "Campus" ADD COLUMN "locatedBy" TEXT;
