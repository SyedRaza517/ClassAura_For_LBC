-- Per-institution branding.
--
-- Purely additive: one new table, no change to any existing one. Every column is
-- nullable, so applying this to a live database creates an empty table and alters
-- nothing — an institution that has set no branding falls back to the platform
-- defaults and looks exactly as it did before.
--
-- No backfill row is created per tenant, deliberately. "No row" and "a row of all
-- nulls" would mean the same thing, and not writing one keeps the meaning of
-- "this college has never customised anything" unambiguous.

CREATE TABLE "TenantBranding" (
    "id" TEXT NOT NULL,

    "displayName" TEXT,
    "shortName" TEXT,
    "wordmarkTop" TEXT,
    "wordmarkSub" TEXT,

    "primaryColor" TEXT,
    "accentColor" TEXT,

    "logoDataUri" TEXT,
    "logoType" TEXT,

    "addressLines" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "website" TEXT,
    "legalFooter" TEXT,
    "signatoryName" TEXT,
    "signatoryTitle" TEXT,
    "mailFrom" TEXT,

    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    "tenantId" TEXT NOT NULL,

    CONSTRAINT "TenantBranding_pkey" PRIMARY KEY ("id")
);

-- One row per institution at most.
CREATE UNIQUE INDEX "TenantBranding_tenantId_key" ON "TenantBranding"("tenantId");

-- Cascade, matching every other tenant-owned table: deleting a customer takes its
-- branding with it rather than leaving an orphan pointing at nothing.
ALTER TABLE "TenantBranding"
    ADD CONSTRAINT "TenantBranding_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Move the EXISTING institution's identity out of the code and into its own row.
--
-- Until now these values were literals in sixteen server files and seventy-six
-- places in the client, so whatever institution this deployment was already serving
-- was rendered with them. Writing them here is therefore behaviour-preserving: the
-- college that is live today looks and reads exactly as it did yesterday, and the
-- difference is that its identity is now DATA it can edit rather than code it cannot.
--
-- Only 'tenant_default' — the tenant the multi-tenancy migration created to adopt
-- every pre-existing row. Institutions created after this get NOTHING here, which is
-- the point: a new college starts neutral and names itself, and can never inherit
-- another customer's name, address, signatory or colours.
INSERT INTO "TenantBranding" (
    "id", "tenantId",
    "displayName", "shortName", "wordmarkTop", "wordmarkSub",
    "primaryColor", "accentColor",
    "addressLines", "contactEmail", "contactPhone", "website",
    "legalFooter", "signatoryName", "signatoryTitle",
    "updatedAt", "updatedBy"
)
SELECT
    'branding_default', 'tenant_default',
    'EdTech', 'EdTech', 'EDTECH', 'HUB',
    '#1a3a8f', '#9e1b32',
    '42 The Burroughs, Hendon, London NW4 4AP',
    'info@edtech.co.uk',
    '+44 7946 830578',
    'www.edtech.co.uk',
    'EdTech is a company limited by guarantee registered in England and Wales 6683232.  Registered Office: 42 The Burroughs, Hendon, London NW4 4AP',
    'Swaroop Arja',
    'Admissions Officer',
    CURRENT_TIMESTAMP, 'migration'
WHERE EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = 'tenant_default');
