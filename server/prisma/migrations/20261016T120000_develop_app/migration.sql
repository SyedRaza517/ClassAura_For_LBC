-- Develop App: which functions this college offers, and the ones it added itself.
--
-- Additive only — two new tables, one index, no foreign keys; nothing existing is
-- touched, there is no data step, and nothing here can destroy a row. Both tables are
-- empty after this runs, and empty is the state that means "this college has changed
-- nothing", so the deployment behaves exactly as it did before the feature existed.
-- That is the whole reason the defaults live in src/appFunctions.js rather than being
-- INSERTed here: a seeded row would make "never configured" indistinguishable from
-- "configured to today's defaults", and the next change to a default would then not
-- reach any college that had been through this migration.

-- AppFunctionConfig is the eleventh constant-key config table (configuration.md): one
-- row, one JSON column, DEFAULT 'singleton' as the primary key. The constant key IS
-- the single-row guarantee — it replaced the old @@unique([tenantId]) — and the save
-- path upserts through it so that two administrators saving at the same moment collide
-- rather than both inserting.
--
-- settings holds { functions, labels, order } together, because the three parts are
-- only meaningful as a set: an order list naming a function that functions switched
-- off is contradictory. It is NOT shallow-merged on save — switching a function back
-- ON is done by deleting its key, and a merge cannot express removal.
CREATE TABLE "AppFunctionConfig" (
  "id"        TEXT NOT NULL DEFAULT 'singleton',
  "settings"  JSONB NOT NULL DEFAULT '{}',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedBy" TEXT,

  CONSTRAINT "AppFunctionConfig_pkey" PRIMARY KEY ("id")
);

-- AppCustomItem is a TABLE OF ROWS, which is the opposite choice from the config above
-- and deliberately so: this is a list that grows and shrinks with independently
-- editable entries, and rows give each one a STABLE id. A JSON array cannot — a
-- reorder silently renumbers every entry, so a deep link or a push that named item 3
-- would afterwards open item 4.
--
-- surface, kind and openIn are TEXT with a vocabulary validated in
-- src/appCustomItems.js rather than Postgres enums, matching Referral.department and
-- ConductEvent.tone: an enum means a migration every time the college needs a new
-- value, and these are the kind of list that grows.
--
-- startsOn / endsOn are TEXT in YYYY-MM-DD, not timestamps. Dates are strings here and
-- compared as strings (conventions.md): a banner window is a calendar decision made in
-- the college's own timezone, not an instant. NULL means no bound in that direction,
-- which is not the same as today — an open-ended banner is the common case.
CREATE TABLE "AppCustomItem" (
  "id"          TEXT NOT NULL,
  "surface"     TEXT NOT NULL,
  "kind"        TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "icon"        TEXT,
  "url"         TEXT,
  "openIn"      TEXT,
  "content"     JSONB,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "startsOn"    TEXT,
  "endsOn"      TEXT,
  "dismissible" BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "updatedBy"   TEXT,

  CONSTRAINT "AppCustomItem_pkey" PRIMARY KEY ("id")
);

-- The one read path is "every enabled item for this surface, in display order", which
-- filters on surface and enabled then orders by sortOrder — one compound index serves
-- the whole query. It is read on every app bootstrap, so it is worth the index on a
-- table that will hold single figures of rows.
CREATE INDEX "AppCustomItem_surface_enabled_sortOrder_idx"
  ON "AppCustomItem"("surface", "enabled", "sortOrder");
