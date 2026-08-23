// Checks the SMTP settings in server/.env and optionally sends a test message.
//
//   node scripts/check-email.mjs                  # connect + authenticate only
//   node scripts/check-email.mjs you@example.com  # also send a test email
//
// Run this before trusting password-reset delivery: it reports exactly which
// setting is wrong instead of leaving you waiting for an email that never lands.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

require(join(server, "node_modules", "dotenv")).config({ path: join(server, ".env") });
const { sendEmail, verifyEmail, describeEmail, isConfigured } = require(join(server, "src", "email.js"));

console.log(`\nMode: ${describeEmail()}\n`);

if (!isConfigured()) {
  console.log("No SMTP settings found, so the app is printing emails to the console.");
  console.log("To send real email, set SMTP_URL (or SMTP_HOST/PORT/USER/PASS) and MAIL_FROM");
  console.log("in server/.env — see server/.env.example for the full list.\n");
  process.exit(0);
}

process.stdout.write("Connecting and authenticating… ");
const v = await verifyEmail();
if (!v.ok) {
  console.log("FAILED");
  console.log(`\n  ${v.error}\n`);
  console.log("Common causes:");
  console.log("  • wrong SMTP_USER / SMTP_PASS (Gmail and Outlook need an app password, not your login)");
  console.log("  • wrong port: 587 for STARTTLS, 465 with SMTP_SECURE=true for implicit TLS");
  console.log("  • the host blocks outbound SMTP, or the account needs 2FA/app-password enabled\n");
  process.exit(1);
}
console.log("OK");

const to = process.argv[2];
if (!to) {
  console.log("\nConnection works. Pass an address to send a test message:");
  console.log("  node scripts/check-email.mjs you@example.com\n");
  process.exit(0);
}

process.stdout.write(`Sending a test message to ${to}… `);
const res = await sendEmail(
  to,
  "Staff Hub email test",
  "This is a test message from the EdTech Staff Hub.\n\nIf you can read this, password-reset emails will reach your staff.",
);
if (res.sent) {
  console.log("SENT");
  if (res.previewUrl) console.log(`\n  Preview: ${res.previewUrl}`);
  console.log(`\n  Message ID: ${res.messageId}\n`);
} else {
  console.log("FAILED");
  console.log(`\n  ${res.error}\n`);
  process.exit(1);
}
