-- A college's own offer-letter PDF, and its own wording for the emails we send.
--
-- Purely additive: two new tables, nothing existing altered. Both are empty on
-- arrival and both default to disabled, so applying this changes no behaviour at all
-- until a college uploads a template and positions its fields. The generated letters
-- and the built-in email wording remain exactly as they are for every institution
-- that does nothing.

CREATE TABLE "TenantDocTemplate" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "pdf" BYTEA NOT NULL,
    "pdfName" TEXT,
    "pdfPages" INTEGER,
    "fields" TEXT,
    -- Off until the fields are positioned. Uploading a letterhead must not silently
    -- start sending letters with no applicant name written on them.
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "tenantId" TEXT NOT NULL,
    CONSTRAINT "TenantDocTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantDocTemplate_tenantId_kind_key" ON "TenantDocTemplate"("tenantId", "kind");
CREATE INDEX "TenantDocTemplate_tenantId_idx" ON "TenantDocTemplate"("tenantId");

ALTER TABLE "TenantDocTemplate"
    ADD CONSTRAINT "TenantDocTemplate_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TenantEmailTemplate" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "tenantId" TEXT NOT NULL,
    CONSTRAINT "TenantEmailTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantEmailTemplate_tenantId_kind_key" ON "TenantEmailTemplate"("tenantId", "kind");
CREATE INDEX "TenantEmailTemplate_tenantId_idx" ON "TenantEmailTemplate"("tenantId");

ALTER TABLE "TenantEmailTemplate"
    ADD CONSTRAINT "TenantEmailTemplate_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
