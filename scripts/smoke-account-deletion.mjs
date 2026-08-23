// Self-service account deletion — required by the App Store and Google Play.
// Checks the guards as hard as the happy path: an irreversible action must not be
// reachable by accident, and must actually remove the personal data it claims to.
//
// Prereq: API running on http://localhost:4000  (npm run dev)
// Usage:  node scripts/smoke-account-deletion.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(pathToFileURL(join(ROOT, "server", "package.json")));
const totp = require(`${ROOT}/server/src/totp.js`);
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);
const db = new PrismaClient({ datasources: { db: { url: `file:${ROOT}/server/prisma/dev.db` } } });

const BASE = process.env.API_URL || "http://localhost:4000/api";
const TAG = `del${Date.now()}`;
const made = [];
let pass = 0, fail = 0;
const check = (l, ok, d = "") => { console.log(`${ok ? "✓" : "✗"} ${l}${d ? "  — " + d : ""}`); ok ? pass++ : fail++; };

async function call(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}
const admin = (await call("/auth/login", { method: "POST", body: { email: "admin@edtech.co.uk", password: "password123" } })).data;

async function mkStaff(suffix, password = "DelPass123!") {
  const email = `${TAG}.${suffix}@edtech.co.uk`;
  const r = await call("/staff", { method: "POST", token: admin.token, body: { name: `Del ${suffix}`, email, password } });
  made.push(email);
  await db.staff.update({ where: { id: r.data.id }, data: { mustChangePassword: false } });
  const lg = await call("/auth/login", { method: "POST", body: { email, password } });
  return { id: r.data.id, email, password, token: lg.data.token };
}

console.log("\n--- guards ---");
const u = await mkStaff("guards");
check("anonymous cannot delete an account", (await call("/auth/account", { method: "DELETE" })).status === 401);
check("missing confirmation phrase refused", (await call("/auth/account", { method: "DELETE", token: u.token, body: { password: u.password } })).status === 400);
check("wrong confirmation phrase refused", (await call("/auth/account", { method: "DELETE", token: u.token, body: { password: u.password, confirm: "delete my account" } })).status === 400);
check("wrong password refused", (await call("/auth/account", { method: "DELETE", token: u.token, body: { password: "NotMyPassword1!", confirm: "DELETE" } })).status === 400);
check("account still exists after those attempts", !!(await db.staff.findUnique({ where: { email: u.email } })));
check("session still works after those attempts", (await call("/auth/me", { token: u.token })).status === 200);

console.log("\n--- a 2FA account also needs its code ---");
const m = await mkStaff("mfa");
const setup = (await call("/auth/totp/setup", { method: "POST", token: m.token, body: { password: m.password } })).data;
await call("/auth/totp/enable", { method: "POST", token: m.token, body: { password: m.password, code: totp.generateCode(setup.secret) } });
const mfaLogin = (await call("/auth/login", { method: "POST", body: { email: m.email, password: m.password } })).data;
const mfaSession = (await call("/auth/totp/verify", { method: "POST", body: { challengeToken: mfaLogin.challengeToken, code: totp.generateCode(setup.secret) } })).data.token;
check("password + phrase alone is NOT enough when 2FA is on", (await call("/auth/account", { method: "DELETE", token: mfaSession, body: { password: m.password, confirm: "DELETE" } })).status === 400);
check("a wrong code is refused", (await call("/auth/account", { method: "DELETE", token: mfaSession, body: { password: m.password, confirm: "DELETE", code: "000000" } })).status === 400);
check("the account survived both attempts", !!(await db.staff.findUnique({ where: { email: m.email } })));
const okDel = await call("/auth/account", { method: "DELETE", token: mfaSession, body: { password: m.password, confirm: "DELETE", code: totp.generateCode(setup.secret) } });
check("correct password + phrase + code deletes it", okDel.status === 200, JSON.stringify(okDel.data));
check("the 2FA account is gone", !(await db.staff.findUnique({ where: { email: m.email } })));

console.log("\n--- the last administrator cannot delete themselves ---");
const adminCount = await db.staff.count({ where: { accountRole: "ADMIN" } });
if (adminCount === 1) {
  const r = await call("/auth/account", { method: "DELETE", token: admin.token, body: { password: "password123", confirm: "DELETE" } });
  check("sole admin is blocked (400)", r.status === 400, r.data?.error);
  check("the admin account still exists", !!(await db.staff.findUnique({ where: { email: "admin@edtech.co.uk" } })));
} else {
  console.log(`… skipped: ${adminCount} admins exist, so this rule does not apply right now`);
}

console.log("\n--- deletion really removes the personal data ---");
const d = await mkStaff("data");
// give them history across every related table
await call("/checkins/check-in", { method: "POST", token: d.token });
await call("/checkins/summary", { method: "PUT", token: d.token, body: { summary: "a day of work" } });
const lv = (await call("/leave", { method: "POST", token: d.token, body: { type: "annual", start: "2026-11-02", end: "2026-11-03", reason: "deletion probe" } })).data;
await call("/adjustments", { method: "POST", token: admin.token, body: { staffId: d.id, days: 2, note: "deletion probe" } });
await call(`/leave/${lv.id}/decision`, { method: "PUT", token: admin.token, body: { status: "approved" } });
const doc = (await call("/documents", { method: "POST", token: admin.token, body: { name: `Del Probe Doc ${TAG}`, type: "Payroll", scope: "personal", assignedTo: d.id } })).data;
// and a sign-up request carrying the same email + a password hash
await db.signupRequest.create({ data: { name: "Del data", email: d.email, passwordHash: "x", jobTitle: "T", dept: "T", status: "approved" } });

const before = {
  checkIns: await db.checkIn.count({ where: { staffId: d.id } }),
  leave: await db.leave.count({ where: { staffId: d.id } }),
  adjustments: await db.adjustment.count({ where: { staffId: d.id } }),
  notifications: await db.notification.count({ where: { staffId: d.id } }),
  signups: await db.signupRequest.count({ where: { email: d.email } }),
};
check("history exists beforehand", before.checkIns > 0 && before.leave > 0 && before.adjustments > 0, JSON.stringify(before));

const del = await call("/auth/account", { method: "DELETE", token: d.token, body: { password: d.password, confirm: "DELETE" } });
check("deletion succeeds", del.status === 200);
check("staff row gone", !(await db.staff.findUnique({ where: { id: d.id } })));
check("check-ins gone", (await db.checkIn.count({ where: { staffId: d.id } })) === 0);
check("leave gone", (await db.leave.count({ where: { staffId: d.id } })) === 0);
check("adjustments gone", (await db.adjustment.count({ where: { staffId: d.id } })) === 0);
check("notifications gone", (await db.notification.count({ where: { staffId: d.id } })) === 0);
check("sign-up request (holds email + password hash) gone", (await db.signupRequest.count({ where: { email: d.email } })) === 0);
check("their session is dead", (await call("/auth/me", { token: d.token })).status === 401);
check("they can no longer sign in", (await call("/auth/login", { method: "POST", body: { email: d.email, password: d.password } })).status === 401);
check("the email can be reused for a new sign-up", (await call("/signup", { method: "POST", body: { name: "Someone New", email: d.email, password: "BrandNew123!", confirmPassword: "BrandNew123!", position: "Tutor", dept: "Teaching" } })).status === 202);

const assigned = await db.document.findUnique({ where: { id: doc.id } });
check("their assigned document is detached, not destroyed", !!assigned && assigned.assignedToId === null);
const adminNotes = (await call("/notifications", { token: admin.token })).data;
check("admins were told about the deletion", adminNotes.some((n) => n.message.includes("deleted their Staff Hub account")));

// cleanup
await db.document.deleteMany({ where: { name: { startsWith: "Del Probe Doc" } } });
await db.signupRequest.deleteMany({ where: { email: { contains: TAG } } });
for (const email of made) {
  const s = await db.staff.findUnique({ where: { email } });
  if (s) await db.staff.delete({ where: { id: s.id } });
}
await db.notification.deleteMany({ where: { message: { contains: "Del " } } });
await db.notification.deleteMany({ where: { message: { contains: TAG } } });
await db.$disconnect();
console.log("\ncleanup: probe accounts, documents and notifications removed");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
