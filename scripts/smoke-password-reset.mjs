// Smoke-tests the forgotten-password flow: request -> emailed token -> reset,
// including the two-factor requirement and session revocation. Self-cleaning.
//
// Prereq: API running on http://localhost:4000  (npm run dev)
// Usage:  node scripts/smoke-password-reset.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import crypto from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));
const totp = require(join(server, "src", "totp.js"));

const BASE = process.env.API_URL || "http://localhost:4000/api";
const SEED_PW = process.env.SEED_PASSWORD || "password123";
const PLAIN_EMAIL = "reset.plain@edtech.co.uk";      // no authenticator
const MFA_EMAIL = "reset.mfa@edtech.co.uk";          // authenticator enrolled
const PASSWORD = "OriginalPass123!";
const NEW_PASSWORD = "BrandNewPass456!";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function call(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
// The same database the API under test is using. This was a hardcoded SQLite file
// path — a leftover from before the move to PostgreSQL — which made every suite that
// touches the database directly fail schema validation before running a single query.
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — point it at a throwaway database."); process.exit(1); }
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
// This client is deliberately bare: it verifies what the API did, so it must not be
// the one the API writes through. It used to also have to look up the seeded tenant
// and stamp tenantId onto every fixture below, because a bare client got no tenant
// injected for it. One deployment now serves one college, tenantId is gone from the
// schema, and a fixture simply belongs to the only institution there is.

const EMAILS = [PLAIN_EMAIL, MFA_EMAIL];
const wipe = async () => {
  await db.staff.deleteMany({ where: { email: { in: EMAILS } } });
  await db.signupRequest.deleteMany({ where: { email: { in: EMAILS } } });
};
await wipe();

const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

// Only the hash of a reset token is stored, so a test can't read a real token out
// of the database — that's the point of the design. Most cases below therefore
// plant a token whose raw value we know, which exercises every consumption rule.
//
// That alone would never catch a mismatch between the token put in the email and
// the hash written to the database, so the end-to-end section further down reads
// the genuine link out of the server's console output when RESET_LOG points at it.
async function issueKnownToken(staffId, { expiresInMs = 30 * 60 * 1000 } = {}) {
  const raw = crypto.randomBytes(32).toString("hex");
  await db.passwordReset.updateMany({ where: { staffId, usedAt: null }, data: { usedAt: new Date() } });
  await db.passwordReset.create({ data: { staffId, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + expiresInMs) } });
  return raw;
}

const admin = (await call("/auth/login", { method: "POST", body: { email: "admin@edtech.co.uk", password: SEED_PW } })).data;

// --- create two staff members through the real sign-up + approval path ---
async function makeStaff(email, name, enrol2fa) {
  await call("/signup", { method: "POST", body: { name, email, password: PASSWORD, confirmPassword: PASSWORD, position: "Tutor", dept: "Teaching" } });
  const req = (await call("/signup?status=pending", { token: admin.token })).data.find((x) => x.email === email);
  const created = (await call(`/signup/${req.id}/decision`, { method: "PUT", token: admin.token, body: { status: "approved" } })).data;
  const login = (await call("/auth/login", { method: "POST", body: { email, password: PASSWORD } })).data;

  // Enrol through whichever route this deployment actually offers, so the suite is
  // valid with mandatory 2FA either ON or OFF:
  //   • challengeToken present  → 2FA is mandatory; enrol mid-sign-in, password
  //     already proven at login, so none is required again.
  //   • no challengeToken       → 2FA is optional; login returned a real session,
  //     so enrol from it — which deliberately demands the password, otherwise
  //     someone holding a borrowed session could add a factor only they hold.
  // Everything this suite asserts about resets and 2FA is equally true of a
  // voluntarily-enrolled account, so no coverage is lost while enforcement is off.
  const viaChallenge = Boolean(login.challengeToken);
  const auth = viaChallenge
    ? { body: { challengeToken: login.challengeToken } }
    : { token: login.token, body: { password: PASSWORD } };

  const setup = (await call("/auth/totp/setup", { method: "POST", token: auth.token, body: { ...auth.body } })).data;
  const enabled = (await call("/auth/totp/enable", { method: "POST", token: auth.token, body: { ...auth.body, code: totp.generateCode(setup.secret) } })).data;
  if (!enrol2fa) {
    // Strip 2FA back off via the admin reset so this account is password-only.
    await call(`/staff/${created.staff.id}/totp`, { method: "DELETE", token: admin.token });
    await db.staff.update({ where: { id: created.staff.id }, data: { mustSetupTotp: false } });
  }
  // Enrolling from a session returns no new token (the caller already had one), so
  // fall back to the session we signed in with.
  return { id: created.staff.id, secret: setup.secret, token: enabled?.token || login.token };
}

console.log("\n--- setup ---");
const mfaUser = await makeStaff(MFA_EMAIL, "Reset Mfa", true);
const plainUser = await makeStaff(PLAIN_EMAIL, "Reset Plain", false);
check("two test accounts created", !!mfaUser.id && !!plainUser.id);

console.log("\n--- requesting a link gives nothing away ---");
let r = await call("/auth/forgot-password", { method: "POST", body: { email: PLAIN_EMAIL } });
const knownMsg = r.data?.message;
check("known address accepted (200)", r.status === 200 && !!knownMsg);
r = await call("/auth/forgot-password", { method: "POST", body: { email: "nobody-here@edtech.co.uk" } });
check("unknown address gives the identical reply", r.status === 200 && r.data?.message === knownMsg);
check("no token is returned to the caller", !JSON.stringify(r.data).match(/token/i));
r = await call("/auth/forgot-password", { method: "POST", body: {} });
check("missing email rejected (400)", r.status === 400);

console.log("\n--- token handling ---");
check("garbage token rejected", (await call("/auth/reset-password/verify", { method: "POST", body: { token: "not-a-real-token" } })).status === 400);

const plainToken = await issueKnownToken(plainUser.id);
r = await call("/auth/reset-password/verify", { method: "POST", body: { token: plainToken } });
check("valid token verifies", r.status === 200 && r.data?.ok === true);
check("verify reports no code needed for a password-only account", r.data?.requiresCode === false);

const expired = await issueKnownToken(plainUser.id, { expiresInMs: -1000 });
check("expired token rejected", (await call("/auth/reset-password/verify", { method: "POST", body: { token: expired } })).status === 400);

// Issuing a new link must kill the previous one.
const first = await issueKnownToken(plainUser.id);
const second = await issueKnownToken(plainUser.id);
check("requesting a new link invalidates the old one", (await call("/auth/reset-password/verify", { method: "POST", body: { token: first } })).status === 400);
check("the newest link still works", (await call("/auth/reset-password/verify", { method: "POST", body: { token: second } })).status === 200);

console.log("\n--- password rules ---");
check("short password rejected", (await call("/auth/reset-password", { method: "POST", body: { token: second, newPassword: "short" } })).status === 400);
check("reusing the current password rejected", (await call("/auth/reset-password", { method: "POST", body: { token: second, newPassword: PASSWORD } })).status === 400);
check("token survives a failed attempt", (await call("/auth/reset-password/verify", { method: "POST", body: { token: second } })).status === 200);

console.log("\n--- reset without 2FA ---");
const plainSession = (await call("/auth/login", { method: "POST", body: { email: PLAIN_EMAIL, password: PASSWORD } })).data.token;
check("account has a live session beforehand", (await call("/auth/me", { token: plainSession })).status === 200);

r = await call("/auth/reset-password", { method: "POST", body: { token: second, newPassword: NEW_PASSWORD } });
check("reset succeeds (200)", r.status === 200);
check("no session handed back by the reset", !r.data?.token);
check("token is single-use", (await call("/auth/reset-password/verify", { method: "POST", body: { token: second } })).status === 400);
check("old password no longer works", (await call("/auth/login", { method: "POST", body: { email: PLAIN_EMAIL, password: PASSWORD } })).status === 401);
check("new password works", !!(await call("/auth/login", { method: "POST", body: { email: PLAIN_EMAIL, password: NEW_PASSWORD } })).data?.token);
check("EXISTING SESSIONS REVOKED", (await call("/auth/me", { token: plainSession })).status === 401);
const plainNotes = (await call("/notifications", { token: (await call("/auth/login", { method: "POST", body: { email: PLAIN_EMAIL, password: NEW_PASSWORD } })).data.token })).data;
check("user notified of the reset", plainNotes.some((n) => /password was reset/i.test(n.message)));

console.log("\n--- reset WITH 2FA: the link alone must not be enough ---");
const mfaToken = await issueKnownToken(mfaUser.id);
r = await call("/auth/reset-password/verify", { method: "POST", body: { token: mfaToken } });
check("verify flags that a code is required", r.data?.requiresCode === true);

r = await call("/auth/reset-password", { method: "POST", body: { token: mfaToken, newPassword: NEW_PASSWORD } });
check("reset WITHOUT a code is refused", r.status === 400, r.data?.error);
r = await call("/auth/reset-password", { method: "POST", body: { token: mfaToken, newPassword: NEW_PASSWORD, code: "000000" } });
check("reset with a WRONG code is refused", r.status === 400);
check("password unchanged after those attempts", !!(await call("/auth/login", { method: "POST", body: { email: MFA_EMAIL, password: PASSWORD } })).data?.mfaRequired);

r = await call("/auth/reset-password", { method: "POST", body: { token: mfaToken, newPassword: NEW_PASSWORD, code: totp.generateCode(mfaUser.secret) } });
check("reset with the correct code succeeds", r.status === 200);
check("2FA still required at sign-in afterwards", (await call("/auth/login", { method: "POST", body: { email: MFA_EMAIL, password: NEW_PASSWORD } })).data?.mfaRequired === true);
check("the 2FA session from before was revoked", (await call("/auth/me", { token: mfaUser.token })).status === 401);

console.log("\n--- end-to-end with the REAL emailed link ---");
// Proves the token placed in the email matches the hash stored in the database.
// Needs the server's console output; skipped (loudly) when it isn't available.
if (!process.env.RESET_LOG) {
  console.log("… SKIPPED — set RESET_LOG=<path to the API's console output> to cover this");
} else {
  const { readFileSync } = await import("node:fs");
  // A brand-new address each run. The reset limiter is keyed on IP + email and
  // survives in the server process, so reusing an address across runs would hit
  // the 5-per-hour cap and silently send no email at all.
  const e2eEmail = `reset.e2e.${Date.now()}@edtech.co.uk`;
  const e2ePassword = "EndToEndPass789!";
  EMAILS.push(e2eEmail);
  const e2eUser = await makeStaff(e2eEmail, "Reset E2e", false);
  check("end-to-end account created", !!e2eUser.id);

  const before = readFileSync(process.env.RESET_LOG, "utf8").length;
  const asked = await call("/auth/forgot-password", { method: "POST", body: { email: e2eEmail } });
  check("reset requested (200)", asked.status === 200);
  await new Promise((r) => setTimeout(r, 900));
  const fresh = readFileSync(process.env.RESET_LOG, "utf8").slice(before);
  const found = [...fresh.matchAll(/\?reset=([0-9a-f]{64})/g)].pop();

  // This section reads the real token out of the console, which only works while
  // email is a stub. Once SMTP is configured the body is no longer logged — the
  // server prints a delivery line instead — and that is the CORRECT behaviour:
  // live reset tokens should not be sitting in server logs. Skip rather than fail.
  const smtpLive = /\[email\] sent to/.test(fresh) && !/\[email:stub\]/.test(fresh);
  if (!found && smtpLive) {
    console.log("… SKIPPED — SMTP is configured, so the link is emailed rather than logged");
    console.log("   (that is correct: reset tokens must not be written to the server log)");
  } else {
    check("the email contains a reset link", !!found);
  }
  if (found) {
    const realToken = found[1];
    check("the REAL emailed token verifies against the stored hash", (await call("/auth/reset-password/verify", { method: "POST", body: { token: realToken } })).status === 200);
    const done = await call("/auth/reset-password", { method: "POST", body: { token: realToken, newPassword: e2ePassword } });
    check("the REAL emailed token completes a reset", done.status === 200, done.data?.error);
    check("sign-in works with that new password", !!(await call("/auth/login", { method: "POST", body: { email: e2eEmail, password: e2ePassword } })).data?.token);
  }
}

console.log("\n--- changing a password signs other devices out ---");
const loginA = (await call("/auth/login", { method: "POST", body: { email: PLAIN_EMAIL, password: NEW_PASSWORD } })).data.token;
const loginB = (await call("/auth/login", { method: "POST", body: { email: PLAIN_EMAIL, password: NEW_PASSWORD } })).data.token;
r = await call("/auth/change-password", { method: "PUT", token: loginA, body: { currentPassword: NEW_PASSWORD, newPassword: PASSWORD } });
check("change-password returns a fresh token for this device", !!r.data?.token);
check("this device keeps working", (await call("/auth/me", { token: r.data.token })).status === 200);
check("the other device is signed out", (await call("/auth/me", { token: loginB })).status === 401);

await wipe();
await db.$disconnect();
console.log("\ncleanup: test accounts removed");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
