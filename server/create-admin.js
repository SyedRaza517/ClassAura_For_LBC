// One-off helper: create or reset the super-admin login.
//
// The password is NEVER hard-coded here. This file is committed, so a literal in it
// is a published credential for anyone holding the repo — which is exactly what it
// used to be ("raza@edtech.co.uk / 123456789", printed to the console for good measure).
// It now comes from the environment and must be a real one.
//
//   cd server
//   ADMIN_EMAIL=you@edtech.co.uk ADMIN_PASSWORD='a-long-passphrase' node create-admin.js
//
// On Windows CMD set the variables first with `set VAR=value`; in PowerShell use
// `$env:VAR = "value"`.
require("dotenv").config();
const { hashPassword } = require("./src/auth");
// The EXTENDED client. On a bare PrismaClient the isolation extension never runs, so
// the create below would supply no tenantId — which is now required — and the whole
// documented recovery path would fail. Through the extended client, running inside
// runInTenant stamps it automatically.
const prisma = require("./src/db");
const { runInTenant, crossTenant } = require("./src/db");

// Which institution this administrator belongs to. A super admin is the top of ONE
// college, not of the platform — that tier is create-platform-admin.js.
const TENANT_SLUG = process.env.TENANT_SLUG || process.env.DEFAULT_TENANT_SLUG || "default";

const MIN_PASSWORD = 12;
// Passwords this project has shipped before, plus the usual suspects. Refused outright
// so a "temporary" one can't quietly become the production credential.
const BANNED = ["123456789", "password123", "password", "changeme", "admin123"];

(async () => {
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "");
  const name = String(process.env.ADMIN_NAME || "Administrator").trim();

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("\n✗ Set ADMIN_EMAIL to a valid address.\n");
    process.exitCode = 1; return;
  }
  // Banned list FIRST: every entry is shorter than MIN_PASSWORD, so checking length
  // first made this branch unreachable and its specific warning never appeared.
  if (BANNED.includes(password.toLowerCase())) {
    console.error("\n✗ That is one of the default passwords this project used to ship. Choose another.\n");
    process.exitCode = 1; return;
  }
  if (password.length < MIN_PASSWORD) {
    console.error(`\n✗ Set ADMIN_PASSWORD to at least ${MIN_PASSWORD} characters.\n`);
    process.exitCode = 1; return;
  }

  // A super admin is the top of ONE institution, not of the platform — that tier is
  // create-platform-admin.js. So this has to say which institution it means.
  const tenant = await crossTenant(() => prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } }));
  if (!tenant) {
    console.error(`\n✗ No institution with slug "${TENANT_SLUG}". Set TENANT_SLUG, or create the institution first.\n`);
    process.exitCode = 1; return;
  }

  try {
    // Inside the tenant, so the isolation extension stamps tenantId on the create.
    await runInTenant(tenant.id, async () => {
    let passwordHash = hashPassword(password);
    if (passwordHash && typeof passwordHash.then === "function") passwordHash = await passwordHash;
    const initials = name.split(/\s+/).map((p) => p[0] || "").join("").slice(0, 2).toUpperCase() || "A";
    // findFirst + create/update rather than upsert: Staff is @@unique([tenantId, email])
    // now, so { where: { email } } is no longer a unique selector and Prisma rejects it.
    const existing = await prisma.staff.findFirst({ where: { email } });
    const s = existing
      ? await prisma.staff.update({
          where: { id: existing.id },
      // tokenVersion increments so any session or reset link issued under the previous
      // password stops working the moment this runs.
          data: { passwordHash, accountRole: "ADMIN", isSuperAdmin: true, adminPages: null, pendingActivation: false, tokenVersion: { increment: 1 },
        // Also clear two-step verification. This is the documented recovery script,
        // and an account locked out by a lost authenticator could not otherwise be
        // recovered — the super-admin guard stops any other admin resetting it.
            totpEnabled: false, totpSecret: null, mustSetupTotp: false },
        })
      : await prisma.staff.create({
          data: {
            name, jobTitle: "Administrator", dept: "Administration", email,
            passwordHash, accountRole: "ADMIN", isSuperAdmin: true, adminPages: null,
            initials, colour: "#6d28d9", allowance: 28, pendingActivation: false,
          },
        });
    console.log(`\n✓ Super admin ready: ${s.email}`);
    console.log(`  Institution: ${tenant.slug}`);
    console.log("  The password is the one you passed in — deliberately not printed here.\n");
    });
  } catch (e) {
    console.error("\n✗ Failed:", e.message, "\n");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
