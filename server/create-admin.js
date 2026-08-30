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
// A plain client. This needed the EXTENDED one while the isolation extension existed:
// a create issued outside runInTenant supplied no tenantId, that column was required,
// and so this entire documented recovery path failed on it. There is no column to
// stamp now — see the header of src/db.js.
const prisma = require("./src/db");

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

  // THIS USED TO HAVE TO SAY WHICH INSTITUTION IT MEANT.
  //
  // It read TENANT_SLUG, looked the institution up, and refused when the slug named
  // none — because a super admin was the top of one college among several, and
  // creating one without saying which college would have been meaningless. One
  // deployment now serves one college, so there is nothing to choose and nothing to
  // get wrong. The separate platform-operator tier the old comment pointed at
  // (create-platform-admin.js) no longer exists at all.
  try {
    let passwordHash = hashPassword(password);
    if (passwordHash && typeof passwordHash.then === "function") passwordHash = await passwordHash;
    const initials = name.split(/\s+/).map((p) => p[0] || "").join("").slice(0, 2).toUpperCase() || "A";
    // findFirst + update/create rather than upsert. Staff.email is a plain unique
    // again, so an upsert WOULD now work — it was findFirst because the unique had
    // become [tenantId, email] and `{ where: { email } }` stopped being a unique
    // selector. It stays split because the two payloads differ in more than a field
    // or two: the update clears two-step verification and bumps tokenVersion, the
    // create fills in a whole employee record. Spelling them out says which applies.
    const existing = await prisma.staff.findFirst({ where: { email } });
    const s = existing
      ? await prisma.staff.update({
          where: { id: existing.id },
          // tokenVersion increments so any session or reset link issued under the
          // previous password stops working the moment this runs.
          data: {
            passwordHash, accountRole: "ADMIN", isSuperAdmin: true, adminPages: null,
            pendingActivation: false, tokenVersion: { increment: 1 },
            // Also clear two-step verification. This is the documented recovery
            // script, and an account locked out by a lost authenticator could not
            // otherwise be recovered — the super-admin guard stops any other admin
            // resetting it.
            totpEnabled: false, totpSecret: null, mustSetupTotp: false,
          },
        })
      : await prisma.staff.create({
          data: {
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
