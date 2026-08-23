// Checks the Firebase settings in server/.env and optionally sends a test push.
//
//   node scripts/check-push.mjs                 # validate credentials only
//   node scripts/check-push.mjs <device-token>  # also send a test notification
//
// Run this before trusting push delivery: it reports exactly which setting is wrong
// instead of leaving you waiting for a notification that never arrives.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

require(join(server, "node_modules", "dotenv")).config({ path: join(server, ".env") });
const { sendPush, verifyPush, describePush, isConfigured } = require(join(server, "src", "push.js"));

console.log(`\nMode: ${describePush()}\n`);

if (!isConfigured()) {
  console.log("No Firebase settings found, so the app logs notifications to the console");
  console.log("instead of delivering them. In-app notifications and email still work.\n");
  console.log("To enable real push:");
  console.log("  1. Create a Firebase project at https://console.firebase.google.com");
  console.log("  2. Add an Android app (package uk.co.edtech.hub) and download google-services.json");
  console.log("     -> client/android/app/google-services.json");
  console.log("  3. For iOS, add an iOS app, download GoogleService-Info.plist into client/ios/App/App/,");
  console.log("     and upload your APNs key under Project settings -> Cloud Messaging");
  console.log("  4. Project settings -> Service accounts -> Generate new private key");
  console.log("  5. Save that JSON outside the repo and set in server/.env:");
  console.log('       FCM_PROJECT_ID="your-project-id"');
  console.log('       FCM_SERVICE_ACCOUNT="C:/secure/path/service-account.json"\n');
  process.exit(0);
}

process.stdout.write("Authenticating with Firebase… ");
const v = await verifyPush();
if (!v.ok) {
  console.log("FAILED");
  console.log(`\n  ${v.error}\n`);
  console.log("Common causes:");
  console.log("  • the service-account JSON is for a different Firebase project than FCM_PROJECT_ID");
  console.log("  • the key was revoked in the Firebase console");
  console.log("  • the private_key lost its newlines when pasted into an env var");
  console.log("    (use FCM_SERVICE_ACCOUNT with a file path instead of inline JSON)");
  console.log("  • no outbound access to oauth2.googleapis.com\n");
  process.exit(1);
}
console.log(`OK  (project ${v.projectId})`);

const token = process.argv[2];
if (!token) {
  console.log("\nCredentials work. To send a test notification, pass a device token:");
  console.log("  node scripts/check-push.mjs <token>");
  console.log("\nGet one by running the app on a real device and looking for the token in");
  console.log("the device log, or read it from the DeviceToken table after signing in.\n");
  process.exit(0);
}

process.stdout.write(`Sending a test notification… `);
const res = await sendPush(token, {
  title: "Staff Hub test",
  body: "If you can see this, push notifications are working.",
  data: { link: "home" },
});
if (res.sent) {
  console.log("SENT\n");
} else {
  console.log("FAILED");
  console.log(`\n  ${res.invalidToken ? "That device token is not valid or the app was uninstalled." : res.error}\n`);
  process.exit(1);
}
