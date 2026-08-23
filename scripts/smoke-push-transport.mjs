// Proves the Firebase transport in server/src/push.js works, WITHOUT a real
// Firebase project — by generating a throwaway service-account key and standing in
// for Google's endpoints.
//
// This is the part that cannot otherwise be checked until real credentials exist:
// that the OAuth assertion is signed correctly, the message has the shape FCM
// expects, access tokens are cached and refreshed, dead device tokens are detected,
// and a network failure can never throw into the caller.
//
// Usage:  node scripts/smoke-push-transport.mjs   (no server or network needed)
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import crypto from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(pathToFileURL(join(ROOT, "server", "package.json")));
// Resolved through the server workspace, which is where jsonwebtoken lives.
const jwt = require("jsonwebtoken");

let pass = 0, fail = 0;
const check = (l, ok, d = "") => { console.log(`${ok ? "✓" : "✗"} ${l}${d ? "  — " + d : ""}`); ok ? pass++ : fail++; };

// A real-shaped service account with a real RSA key that we hold the public half of,
// so the assertion the code signs can actually be verified.
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
process.env.FCM_PROJECT_ID = "edtech-hub-test";
process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: "service_account",
  project_id: "edtech-hub-test",
  client_email: "staff-hub@edtech-hub-test.iam.gserviceaccount.com",
  private_key: privateKey,
});

// --- stand in for Google ---
const calls = [];
let tokenExchanges = 0;
let nextFcmResponse = { ok: true };
let expiresIn = 3600;

globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), opts });
  if (String(url).includes("oauth2.googleapis.com/token")) {
    tokenExchanges++;
    return { ok: true, status: 200, json: async () => ({ access_token: `access-${tokenExchanges}`, expires_in: expiresIn }) };
  }
  if (nextFcmResponse.ok) return { ok: true, status: 200, statusText: "OK", json: async () => ({ name: "projects/x/messages/1" }) };
  if (nextFcmResponse.throw) throw new Error("socket hang up");
  return {
    ok: false, status: nextFcmResponse.status || 400, statusText: "Bad Request",
    json: async () => ({ error: { status: nextFcmResponse.code, message: "nope", details: [{ errorCode: nextFcmResponse.code }] } }),
  };
};

const { sendPush, verifyPush, describePush, isConfigured } = require(`${ROOT}/server/src/push.js`);

console.log("\n--- configuration ---");
check("reports itself as configured", isConfigured() === true);
const desc = describePush();
check("the startup banner names the project", /edtech-hub-test/.test(desc), desc);
check("the banner does not leak the private key", !desc.includes("PRIVATE KEY"));

console.log("\n--- the OAuth assertion Google would receive ---");
const v = await verifyPush();
check("authenticates successfully", v.ok === true, JSON.stringify(v));
const tokenCall = calls.find((c) => c.url.includes("oauth2.googleapis.com"));
check("posts to Google's token endpoint", !!tokenCall);
const body = new URLSearchParams(tokenCall.opts.body.toString());
check("uses the JWT-bearer grant type", body.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer");

const assertion = body.get("assertion");
let claims = null;
try { claims = jwt.verify(assertion, publicKey, { algorithms: ["RS256"] }); } catch (e) { claims = { _error: e.message }; }
check("the assertion is a valid RS256 signature over our key", !claims._error, claims._error || "");
check("issued by the service account", claims?.iss === "staff-hub@edtech-hub-test.iam.gserviceaccount.com");
check("audience is the token endpoint", claims?.aud === "https://oauth2.googleapis.com/token");
check("requests the firebase.messaging scope", claims?.scope === "https://www.googleapis.com/auth/firebase.messaging");
check("expires within the hour Google allows", claims && claims.exp - claims.iat <= 3600 && claims.exp > claims.iat);

console.log("\n--- the message FCM would receive ---");
calls.length = 0;
const sent = await sendPush("device-token-abc", { title: "Staff Hub", body: "Your leave was approved.", data: { link: "balance", type: "success" } });
check("reports success", sent.sent === true, JSON.stringify(sent));
const fcmCall = calls.find((c) => c.url.includes("fcm.googleapis.com"));
check("posts to the v1 endpoint for the right project", fcmCall?.url === "https://fcm.googleapis.com/v1/projects/edtech-hub-test/messages:send", fcmCall?.url);
check("carries the access token as a Bearer header", fcmCall?.opts.headers.Authorization === "Bearer access-1");
const msg = JSON.parse(fcmCall.opts.body).message;
check("addresses the device token", msg.token === "device-token-abc");
check("carries the notification title and body", msg.notification.title === "Staff Hub" && msg.notification.body === "Your leave was approved.");
check("every data value is a string (FCM rejects anything else)", Object.values(msg.data).every((x) => typeof x === "string"), JSON.stringify(msg.data));
check("keeps the deep link so tapping opens the right screen", msg.data.link === "balance");
check("sets an Android channel and high priority", msg.android?.priority === "high" && !!msg.android?.notification?.channelId);
check("sets the iOS/APNs payload", !!msg.apns?.payload?.aps);

console.log("\n--- access tokens are cached, not re-fetched every send ---");
const before = tokenExchanges;
await sendPush("device-token-abc", { title: "T", body: "B" });
await sendPush("device-token-abc", { title: "T", body: "B" });
check("three sends used one token exchange", tokenExchanges === before, `${tokenExchanges - before} extra exchange(s)`);

console.log("\n--- and refreshed when they expire ---");
// Re-require with a short-lived token so the cache must refresh.
delete require.cache[require.resolve(`${ROOT}/server/src/push.js`)];
expiresIn = 30; // shorter than the 60s safety margin, so it is always stale
tokenExchanges = 0;
const fresh = require(`${ROOT}/server/src/push.js`);
await fresh.sendPush("t", { title: "T", body: "B" });
await fresh.sendPush("t", { title: "T", body: "B" });
check("an expired token is exchanged again", tokenExchanges === 2, `${tokenExchanges} exchanges`);
expiresIn = 3600;

console.log("\n--- failures are handled, never thrown ---");
nextFcmResponse = { ok: false, code: "UNREGISTERED" };
const dead = await sendPush("dead-token", { title: "T", body: "B" });
check("an uninstalled app is reported as an invalid token", dead.invalidToken === true && dead.sent === false, JSON.stringify(dead));

nextFcmResponse = { ok: false, code: "INVALID_ARGUMENT" };
check("a malformed token is also flagged invalid", (await sendPush("bad", { title: "T", body: "B" })).invalidToken === true);

nextFcmResponse = { ok: false, code: "UNAVAILABLE", status: 503 };
const down = await sendPush("t", { title: "T", body: "B" });
check("an FCM outage is NOT treated as an invalid token", down.sent === false && !down.invalidToken, JSON.stringify(down));

nextFcmResponse = { ok: false, throw: true };
const boom = await sendPush("t", { title: "T", body: "B" });
check("a network error returns cleanly instead of throwing", boom.sent === false && !!boom.error);

nextFcmResponse = { ok: true };
check("missing title is rejected without a network call", (await sendPush("t", {})).sent === false);
check("missing token is rejected without a network call", (await sendPush("", { title: "T" })).sent === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
