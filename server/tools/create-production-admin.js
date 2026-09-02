#!/usr/bin/env node
// Create (or reset) a PLAIN ADMIN login on the production database.
//
// WHY THIS EXISTS RATHER THAN server/create-admin.js. That script was rewritten for the
// de-tenanted schema and no longer supplies a tenantId. Production has not taken the
// de-tenanting migration yet, so `Staff.tenantId` is still NOT NULL there and the newer
// script fails on the required column. This one is pinned to the schema production is
// ACTUALLY running, and should be deleted once production is de-tenanted.
//
// THE TENANT IS THE WHOLE PROBLEM, so it is worth stating. Production still resolves an
// institution per request: X-Tenant header, then subdomain, then DEFAULT_TENANT_SLUG.
// The production client sends no header and the Render hostname is not a customer
// subdomain, so requests through the ordinary production URL land on DEFAULT_TENANT_SLUG
// — "default". The audit log shows the consequence plainly: ahmed@gmail.com signs in
// successfully against "londonbrookes-college", and fails against "default", because the
// account exists in the first and not the second. An account created in the wrong
// institution is invisible to the login that needs it.
//
// So the default here is the institution the production URL resolves to. Override with
// TENANT_SLUG if you are reaching the API by some other host.
//
// SAFE TO RE-RUN. An existing account with the same email in the same institution has
// its password reset rather than being duplicated — a duplicate would also break the
// de-tenanting migration later, when Staff.email becomes unique on its own.
//
// Usage (PowerShell):
//   $env:DATABASE_URL="postgresql://..."; $env:ADMIN_PASSWORD="a-long-passphrase"
//   node server/tools/create-production-admin.js
//
// Usage (bash). Note an "@" in a password must be percent-encoded as %40 inside the URL:
//   DATABASE_URL="postgresql://..." ADMIN_PASSWORD='a-long-passphrase' \
//     node server/tools/create-production-admin.js
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const EMAIL = process.env.ADMIN_EMAIL || "admin@edtech.co.uk";
const PASSWORD = process.env.ADMIN_PASSWORD;
const SLUG = process.env.TENANT_SLUG || "default";

const MIN = 12;
// Passwords this project has shipped before, plus the usual suspects — refused so a
// "temporary" one cannot quietly become the production credential. Same list as
// create-admin.js, for the same reason.
const BANNED = ["123456789", "password123", "password", "changeme", "admin123"];
const die = (m) => { console.error(`\nREFUSING: ${m}\n`); process.exit(1); };

(async () => {
  if (!process.env.DATABASE_URL) die("DATABASE_URL is not set. Pass production's connection string on the command line.");
  if (!PASSWORD) die("ADMIN_PASSWORD is not set. It is never hard-coded here — this file is committed.");
  if (PASSWORD.length < MIN) die(`ADMIN_PASSWORD must be at least ${MIN} characters.`);
  if (BANNED.includes(PASSWORD.toLowerCase())) die("that password is on the banned list.");

  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const host = (process.env.DATABASE_URL.match(/@([^/:]+)/) || [])[1];
  console.log(`\nDatabase host: ${host}`);

  const t = await db.$queryRawUnsafe(`SELECT id, name, slug FROM "Tenant" WHERE slug = $1`, SLUG);
  if (!t.length) {
    const all = await db.$queryRawUnsafe(`SELECT slug, name FROM "Tenant"`);
    console.table(all);
    die(`no institution with slug "${SLUG}". Pick one of the above with TENANT_SLUG=...`);
  }
  const tenant = t[0];
  console.log(`Institution:   ${tenant.name} (${tenant.slug})\n`);

  const existing = await db.$queryRawUnsafe(
    `SELECT id, email, "isSuperAdmin" FROM "Staff" WHERE email = $1 AND "tenantId" = $2`, EMAIL, tenant.id);
  const hash = await bcrypt.hash(PASSWORD, 10);

  if (existing.length) {
    // Reset, never duplicate. Two rows sharing an email would survive here and then
    // collide when de-tenanting makes Staff.email unique on its own.
    await db.$executeRawUnsafe(
      `UPDATE "Staff" SET "passwordHash" = $1, "accountRole" = $2, "mustChangePassword" = false,
       "tokenVersion" = "tokenVersion" + 1 WHERE id = $3`, hash, "ADMIN", existing[0].id);
    console.log(`Reset the password on the existing account ${EMAIL}.`);
    if (existing[0].isSuperAdmin) console.log("NOTE: that account is a SUPER ADMIN. Left as one — this script does not demote.");
  } else {
    await db.$executeRawUnsafe(
      `INSERT INTO "Staff" (id, name, "jobTitle", dept, email, "passwordHash", initials, colour, "tenantId", "accountRole", "isSuperAdmin", "mustChangePassword")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,false)`,
      "stf_" + crypto.randomBytes(12).toString("hex"), "Administrator", "Administrator", "Administration",
      EMAIL, hash, "AD", "#2a78d6", tenant.id, "ADMIN");
    // isSuperAdmin false on purpose: a plain admin. adminPages is left NULL, which the
    // server reads as "every page except the explicit-only ones" — so this account sees
    // the whole console, including the Admission Tracker once production has it.
    console.log(`Created ${EMAIL} as a plain ADMIN (not a super admin).`);
  }

  console.log("\nAccounts in this institution:");
  console.table(await db.$queryRawUnsafe(
    `SELECT email, name, "accountRole", "isSuperAdmin", "mustChangePassword" FROM "Staff" WHERE "tenantId" = $1 ORDER BY email`,
    tenant.id));
  console.log(`\nSign in with:  ${EMAIL}  /  (the ADMIN_PASSWORD you passed)\n`);
  await db.$disconnect();
})().catch((e) => { console.error("\nFAILED:", e.message, "\n"); process.exit(1); });
