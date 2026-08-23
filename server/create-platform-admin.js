// Creates or resets a PLATFORM operator — the tier above every institution.
//
// This account can see and act on every customer's data, so it is created from the
// command line by someone with server access, never through a web form. There is no
// sign-up for it and no "forgot password" flow: recovery is re-running this.
//
//   cd server
//   PLATFORM_EMAIL=you@example.com PLATFORM_PASSWORD='a-long-passphrase' node create-platform-admin.js
//
// PowerShell:  $env:PLATFORM_EMAIL = "..."   CMD:  set PLATFORM_EMAIL=...
//
// The password is never hard-coded here and never printed. This file is committed;
// a literal in it would be a published credential for the whole platform.
require("dotenv").config();
const bcrypt = require("bcryptjs");
const prisma = require("./src/db");
const { crossTenant } = require("./src/db");

const MIN_PASSWORD = 12;
const BANNED = ["password123", "changeme", "admin123", "123456789", "platform123"];

(async () => {
  const email = String(process.env.PLATFORM_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.PLATFORM_PASSWORD || "");
  const name = String(process.env.PLATFORM_NAME || "Platform Operator").trim();

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("\n  Set PLATFORM_EMAIL to a valid address.\n");
    process.exitCode = 1; return;
  }
  if (BANNED.includes(password.toLowerCase())) {
    console.error("\n  That is a well-known default. Choose another.\n");
    process.exitCode = 1; return;
  }
  if (password.length < MIN_PASSWORD) {
    console.error(`\n  Set PLATFORM_PASSWORD to at least ${MIN_PASSWORD} characters.\n`);
    process.exitCode = 1; return;
  }

  try {
    const admin = await crossTenant(() => prisma.platformAdmin.upsert({
      where: { email },
      // tokenVersion increments so any session issued under the previous password
      // stops working the moment this runs.
      update: { passwordHash: bcrypt.hashSync(password, 10), active: true, name, tokenVersion: { increment: 1 } },
      create: { email, name, passwordHash: bcrypt.hashSync(password, 10) },
    }));
    console.log(`\n  Platform operator ready: ${admin.email}`);
    console.log("  The password is the one you passed in — deliberately not printed.\n");
  } catch (e) {
    console.error("\n  Failed:", e.message, "\n");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
