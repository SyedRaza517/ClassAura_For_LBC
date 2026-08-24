-- Per-institution attendance bands.
--
-- The bands a student's attendance percentage is classified against — and which of
-- those bands sends an automatic letter — were six values in the code. That is one
-- college's attendance policy applied to every college on the platform: another
-- warns at 75%, escalates at 60%, runs three bands rather than six, or emails only
-- the bottom one. Bands decide who receives a letter saying their place is at risk,
-- so running one institution's thresholds over another's students is not cosmetic.
--
-- Purely additive: one new table, no change to any existing one, no backfill.
-- Applying this to a live database creates an empty table and alters nothing. A
-- college with no row here resolves to the same six bands the code used yesterday
-- (see attendanceBandConfig.js), so behaviour is unchanged until someone edits them.
--
-- No default row is written per tenant, deliberately — as with TenantBranding.
-- "No row" and "a row that happens to hold the default six" would otherwise mean
-- the same thing, and not writing one keeps "this college has never changed its
-- bands" unambiguous, which is what makes "reset to the defaults" expressible.

CREATE TABLE "AttendanceBandConfig" (
    "id" TEXT NOT NULL,

    -- The whole ladder, best -> worst, as a JSON array of
    -- { key, label, min, max, colour, emailTrigger }.
    --
    -- One column rather than a row per band: a band list is only valid as a SET (it
    -- must tile 0-100 with no gap and no overlap), and a single column replaces that
    -- set atomically. With a row per band there is a window between statements in
    -- which the ladder has a hole in it, and a student landing in that hole is
    -- classified as having no attendance data and silently skipped by the send.
    "bands" JSONB NOT NULL,

    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    "tenantId" TEXT NOT NULL,

    CONSTRAINT "AttendanceBandConfig_pkey" PRIMARY KEY ("id")
);

-- One row per institution at most.
CREATE UNIQUE INDEX "AttendanceBandConfig_tenantId_key" ON "AttendanceBandConfig"("tenantId");

-- Cascade, matching every other tenant-owned table: deleting a customer takes its
-- band configuration with it rather than leaving an orphan pointing at nothing.
ALTER TABLE "AttendanceBandConfig"
    ADD CONSTRAINT "AttendanceBandConfig_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
