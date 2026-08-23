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
const { PrismaClient } = require("@prisma/client");
const { hashPassword } = require("./src/auth");
const prisma = new PrismaClient();

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

  try {
    let passwordHash = hashPassword(password);
    if (passwordHash && typeof passwordHash.then === "function") passwordHash = await passwordHash;
    const initials = name.split(/\s+/).map((p) => p[0] || "").join("").slice(0, 2).toUpperCase() || "A";
    const s = await prisma.staff.upsert({
      where: { email },
      // tokenVersion increments so any session or reset link issued under the previous
      // password stops working the moment this runs.
      update: { passwordHash, accountRole: "ADMIN", isSuperAdmin: true, adminPages: null, pendingActivation: false, tokenVersion: { increment: 1 },
        // Also clear two-step verification. This is the documented recovery script,
        // and an account locked out by a lost authenticator could not otherwise be
        // recovered — the super-admin guard stops any other admin resetting it.
        totpEnabled: false, totpSecret: null, mustSetupTotp: false },
      create: {
        name, jobTitle: "Administrator", dept: "Administration", email,
        passwordHash, accountRole: "ADMIN", isSuperAdmin: true, adminPages: null,
        initials, colour: "#6d28d9", allowance: 28, pendingActivation: false,
      },
    });
    console.log(`\n✓ Super admin ready: ${s.email}`);
    console.log("  The password is the one you passed in — deliberately not printed here.\n");
  } catch (e) {
    console.error("\n✗ Failed:", e.message, "\n");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
