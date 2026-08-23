// Smoke-tests the mobile sign-up -> admin approval -> authenticator (TOTP) flow
// against the running API, then removes everything it created.
//
// Prereq: API running on http://localhost:4000  (npm run dev)
// Usage:  node scripts/smoke-signup-2fa.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));
const totp = require(join(server, "src", "totp.js"));

const BASE = process.env.API_URL || "http://localhost:4000/api";
const EMAIL = "smoke.applicant@edtech.co.uk";
const REJECT_EMAIL = "smoke.rejected@edtech.co.uk";
const PASSWORD = "SmokePass123!";
const NAME = "Smoke Applicant";

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

// Start from a known state — a previous aborted run would invalidate the checks.
const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const db = new PrismaClient({ datasources: { db: { url: `file:${join(server, "prisma", "dev.db").replace(/\\/g, "/")}` } } });
const wipe = async () => {
  await db.staff.deleteMany({ where: { email: { in: [EMAIL, REJECT_EMAIL] } } });
  await db.signupRequest.deleteMany({ where: { email: { in: [EMAIL, REJECT_EMAIL] } } });
  await db.notification.deleteMany({ where: { message: { contains: NAME } } });
  await db.notification.deleteMany({ where: { message: { contains: "Smoke Rejected" } } });
};
await wipe();

console.log("\n--- sign-up ---");
let r = await call("/signup", { method: "POST", body: { name: NAME, email: EMAIL, password: PASSWORD, confirmPassword: PASSWORD, position: "Lecturer", dept: "Teaching" } });
check("sign-up accepted (202)", r.status === 202);

r = await call("/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
check("cannot sign in while pending (401)", r.status === 401);

r = await call("/signup", { method: "POST", body: { name: "X", email: "bad-email", password: PASSWORD, position: "P", dept: "D" } });
check("invalid email rejected (400)", r.status === 400);
r = await call("/signup", { method: "POST", body: { name: "X", email: "someone@edtech.co.uk", password: "short", position: "P", dept: "D" } });
check("short password rejected (400)", r.status === 400);
r = await call("/signup", { method: "POST", body: { name: "X", email: "someone@edtech.co.uk", password: PASSWORD, confirmPassword: "Nope12345", position: "P", dept: "D" } });
check("mismatched confirmation rejected (400)", r.status === 400);
r = await call("/signup", { method: "POST", body: { name: "X", email: "admin@edtech.co.uk", password: PASSWORD, position: "P", dept: "D" } });
check("existing email leaks nothing (202, not 400)", r.status === 202);

console.log("\n--- admin queue ---");
const admin = (await call("/auth/login", { method: "POST", body: { email: "admin@edtech.co.uk", password: "password123" } })).data;
check("admin still signs in one step (no 2FA)", !!admin.token && !admin.mfaRequired);

const pending = (await call("/signup?status=pending", { token: admin.token })).data;
const mine = pending.find((x) => x.email === EMAIL);
check("request visible to admin", !!mine);
check("position and department captured", mine?.role === "Lecturer" && mine?.dept === "Teaching");

const staff = (await call("/auth/login", { method: "POST", body: { email: "j.whitfield@edtech.co.uk", password: "password123" } })).data;
check("staff cannot list requests (403)", (await call("/signup", { token: staff.token })).status === 403);
check("staff cannot approve (403)", (await call(`/signup/${mine.id}/decision`, { method: "PUT", token: staff.token, body: { status: "approved" } })).status === 403);

console.log("\n--- approval ---");
r = await call(`/signup/${mine.id}/decision`, { method: "PUT", token: admin.token, body: { status: "approved", allowance: 25 } });
check("approval creates the account (201)", r.status === 201);
check("allowance applied", r.data?.staff?.allowance === 25);
check("2FA mandatory on the new account", r.data?.staff?.totpRequired === true);
check("TOTP secret never serialised", r.data?.staff?.totpSecret === undefined);
check("cannot re-decide (409)", (await call(`/signup/${mine.id}/decision`, { method: "PUT", token: admin.token, body: { status: "rejected" } })).status === 409);

console.log("\n--- first sign-in: enrolment ---");
r = await call("/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
check("password alone yields no session", !r.data?.token);
check("enrolment demanded", r.data?.totpSetupRequired === true);
const setupChallenge = r.data.challengeToken;

check("challenge token is not a session token", (await call("/auth/me", { token: setupChallenge })).status === 401);

const setup = (await call("/auth/totp/setup", { method: "POST", body: { challengeToken: setupChallenge } })).data;
check("setup returns a secret", typeof setup?.secret === "string" && setup.secret.length === 32);
check("setup returns an otpauth URL", String(setup?.otpauthUrl).startsWith("otpauth://totp/"));

check("wrong enrolment code rejected (400)", (await call("/auth/totp/enable", { method: "POST", body: { challengeToken: setupChallenge, code: "000000" } })).status === 400);
r = await call("/auth/totp/enable", { method: "POST", body: { challengeToken: setupChallenge, code: totp.generateCode(setup.secret) } });
check("correct code completes enrolment", !!r.data?.token);
check("2FA reported as enabled", r.data?.user?.totpEnabled === true);
const session = r.data.token;

check("session works", (await call("/auth/me", { token: session })).data?.email === EMAIL);
check("new account is still STAFF-only (403 on admin write)", (await call("/staff", { method: "POST", token: session, body: { name: "Y", email: "y@z.co" } })).status === 403);
check("mandatory 2FA cannot be removed (400)", (await call("/auth/totp", { method: "DELETE", token: session, body: { password: PASSWORD } })).status === 400);

console.log("\n--- later sign-ins: verification ---");
r = await call("/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
check("code demanded", r.data?.mfaRequired === true && !r.data?.token);
const verifyChallenge = r.data.challengeToken;
check("wrong code rejected (400)", (await call("/auth/totp/verify", { method: "POST", body: { challengeToken: verifyChallenge, code: "123456" } })).status === 400);
check("correct code returns a session", !!(await call("/auth/totp/verify", { method: "POST", body: { challengeToken: verifyChallenge, code: totp.generateCode(setup.secret) } })).data?.token);

console.log("\n--- the pending enrolment secret must be STABLE ---");
// Regression: /totp/setup used to mint a new secret on every call, so any re-mount
// of the enrolment screen (refresh, back-and-forth, React StrictMode's double
// effect, a retry after a mistyped code) silently invalidated the QR the user had
// already scanned — their authenticator could then never produce an accepted code.
{
  const stableEmail = `smoke.stable.${Date.now()}@edtech.co.uk`;
  await call("/signup", { method: "POST", body: { name: "Smoke Stable", email: stableEmail, password: PASSWORD, confirmPassword: PASSWORD, position: "Tutor", dept: "Teaching" } });
  const sreq = (await call("/signup?status=pending", { token: admin.token })).data.find((x) => x.email === stableEmail);
  await call(`/signup/${sreq.id}/decision`, { method: "PUT", token: admin.token, body: { status: "approved" } });
  const l1 = (await call("/auth/login", { method: "POST", body: { email: stableEmail, password: PASSWORD } })).data;

  const a = await call("/auth/totp/setup", { method: "POST", body: { challengeToken: l1.challengeToken } });
  const b = await call("/auth/totp/setup", { method: "POST", body: { challengeToken: l1.challengeToken } });
  check("a repeated setup call returns the SAME secret", a.data?.secret === b.data?.secret, `${a.data?.secret?.slice(0, 8)} vs ${b.data?.secret?.slice(0, 8)}`);

  const [c, d] = await Promise.all([
    call("/auth/totp/setup", { method: "POST", body: { challengeToken: l1.challengeToken } }),
    call("/auth/totp/setup", { method: "POST", body: { challengeToken: l1.challengeToken } }),
  ]);
  check("two CONCURRENT setup calls return the same secret", c.data?.secret === d.data?.secret, `${c.data?.secret?.slice(0, 8)} vs ${d.data?.secret?.slice(0, 8)}`);
  check("and it still matches the first one", a.data?.secret === c.data?.secret);

  // The code from the very first QR must still work after all those calls.
  const en = await call("/auth/totp/enable", { method: "POST", body: { challengeToken: l1.challengeToken, code: totp.generateCode(a.data.secret) } });
  check("a code from the ORIGINAL QR still enrols", en.status === 200, `got ${en.status} ${en.data?.error || ""}`);

  await db.staff.deleteMany({ where: { email: stableEmail } });
  await db.signupRequest.deleteMany({ where: { email: stableEmail } });
  await db.notification.deleteMany({ where: { message: { contains: "Smoke Stable" } } });
}

console.log("\n--- admin resets a lost authenticator ---");
const newStaffId = (await call("/auth/me", { token: session })).data.id;
check("staff cannot reset anyone's 2FA (403)", (await call(`/staff/${newStaffId}/totp`, { method: "DELETE", token: staff.token })).status === 403);
check("resetting an account without 2FA is rejected (400)", (await call(`/staff/${(await call("/auth/me", { token: staff.token })).data.id}/totp`, { method: "DELETE", token: admin.token })).status === 400);
check("unknown staff id (404)", (await call("/staff/does-not-exist/totp", { method: "DELETE", token: admin.token })).status === 404);

r = await call(`/staff/${newStaffId}/totp`, { method: "DELETE", token: admin.token });
check("admin reset succeeds (200)", r.status === 200);
check("2FA reported off after reset", r.data?.totpEnabled === false);
check("still flagged as mandatory", r.data?.totpRequired === true);

check("the old authenticator code no longer works", (await call("/auth/totp/verify", { method: "POST", body: { challengeToken: verifyChallenge, code: totp.generateCode(setup.secret) } })).status !== 200);

r = await call("/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
check("next sign-in forces re-enrolment", r.data?.totpSetupRequired === true && !r.data?.token);

// Re-enrol with a brand-new authenticator and confirm the account works again.
const setup2 = (await call("/auth/totp/setup", { method: "POST", body: { challengeToken: r.data.challengeToken } })).data;
check("a fresh secret is issued", setup2.secret !== setup.secret);
check("old secret rejected against the new enrolment", (await call("/auth/totp/enable", { method: "POST", body: { challengeToken: r.data.challengeToken, code: totp.generateCode(setup.secret) } })).status === 400);
r = await call("/auth/totp/enable", { method: "POST", body: { challengeToken: r.data.challengeToken, code: totp.generateCode(setup2.secret) } });
check("re-enrolment restores access", !!r.data?.token);
check("the user was notified of the reset", (await call("/notifications", { token: r.data.token })).data.some((n) => /reset your two-step/i.test(n.message)));

console.log("\n--- rejection ---");
await call("/signup", { method: "POST", body: { name: "Smoke Rejected", email: REJECT_EMAIL, password: PASSWORD, position: "Tutor", dept: "Teaching" } });
const rej = (await call("/signup?status=pending", { token: admin.token })).data.find((x) => x.email === REJECT_EMAIL);
r = await call(`/signup/${rej.id}/decision`, { method: "PUT", token: admin.token, body: { status: "rejected", note: "No vacancy" } });
check("rejection recorded", r.status === 200 && r.data?.request?.status === "rejected");
check("no account created on rejection", r.data?.staff === null);
check("rejected applicant cannot sign in (401)", (await call("/auth/login", { method: "POST", body: { email: REJECT_EMAIL, password: PASSWORD } })).status === 401);
check("rejected applicant may re-apply (202)", (await call("/signup", { method: "POST", body: { name: "Smoke Rejected", email: REJECT_EMAIL, password: PASSWORD, position: "Tutor", dept: "Teaching" } })).status === 202);

await wipe();
await db.$disconnect();
console.log("\ncleanup: test accounts, requests and notifications removed");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
