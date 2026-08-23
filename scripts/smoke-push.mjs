// Push-notification plumbing: device registration, ownership, and the fan-out from
// a real notification. Works with FCM unconfigured — the sender is a stub then, so
// these checks exercise everything except the final hop to Google.
//
// Prereq: API running on http://localhost:4000  (npm run dev)
// Usage:  node scripts/smoke-push.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(pathToFileURL(join(ROOT, "server", "package.json")));
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);
// The same database the API under test is using. This was a hardcoded SQLite file
// path — a leftover from before the move to PostgreSQL — which made every suite that
// touches the database directly fail schema validation before running a single query.
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — point it at a throwaway database."); process.exit(1); }
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const BASE = process.env.API_URL || "http://localhost:4000/api";
const SEED_PW = process.env.SEED_PASSWORD || "password123";
const TAG = `push${Date.now()}`;
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
const admin = (await call("/auth/login", { method: "POST", body: { email: "admin@edtech.co.uk", password: SEED_PW } })).data;

async function mkStaff(suffix) {
  const email = `${TAG}.${suffix}@edtech.co.uk`;
  const r = await call("/staff", { method: "POST", token: admin.token, body: { name: `Push ${suffix}`, email, password: "PushPass123!" } });
  made.push(email);
  await db.staff.update({ where: { id: r.data.id }, data: { mustChangePassword: false } });
  const lg = await call("/auth/login", { method: "POST", body: { email, password: "PushPass123!" } });
  return { id: r.data.id, email, token: lg.data.token };
}

const TOKEN_A = `fake-fcm-token-${TAG}-aaaaaaaaaaaaaaaaaaaa`;
const TOKEN_B = `fake-fcm-token-${TAG}-bbbbbbbbbbbbbbbbbbbb`;

console.log("\n--- registration ---");
const u = await mkStaff("one");
check("anonymous cannot register a device", (await call("/devices", { method: "POST", body: { token: TOKEN_A, platform: "android" } })).status === 401);
check("a missing token is rejected", (await call("/devices", { method: "POST", token: u.token, body: { platform: "android" } })).status === 400);
check("a too-short token is rejected", (await call("/devices", { method: "POST", token: u.token, body: { token: "abc", platform: "android" } })).status === 400);
check("a non-string token is rejected", (await call("/devices", { method: "POST", token: u.token, body: { token: 12345 } })).status === 400);

const reg = await call("/devices", { method: "POST", token: u.token, body: { token: TOKEN_A, platform: "android" } });
check("a valid token registers (201)", reg.status === 201, `platform=${reg.data?.platform}`);
check("stored against the right staff member", (await db.deviceToken.findUnique({ where: { token: TOKEN_A } }))?.staffId === u.id);
check("an unknown platform is normalised, not stored raw", (await call("/devices", { method: "POST", token: u.token, body: { token: TOKEN_B, platform: "windows-phone" } })).data?.platform === "unknown");

console.log("\n--- re-registering is idempotent ---");
const before = await db.deviceToken.count({ where: { staffId: u.id } });
await call("/devices", { method: "POST", token: u.token, body: { token: TOKEN_A, platform: "android" } });
check("registering the same token again does not duplicate it", (await db.deviceToken.count({ where: { staffId: u.id } })) === before, `${before} devices`);

console.log("\n--- a shared phone must follow the person signed in ---");
const v = await mkStaff("two");
await call("/devices", { method: "POST", token: v.token, body: { token: TOKEN_A, platform: "android" } });
const moved = await db.deviceToken.findUnique({ where: { token: TOKEN_A } });
check("the device MOVES to the new user", moved?.staffId === v.id);
check("the previous user no longer has it", (await db.deviceToken.count({ where: { staffId: u.id, token: TOKEN_A } })) === 0);
check("it is not duplicated across both accounts", (await db.deviceToken.count({ where: { token: TOKEN_A } })) === 1);

console.log("\n--- listing and unregistering ---");
const list = await call("/devices", { token: v.token });
check("a user can list their own devices", list.status === 200 && list.data.length >= 1);
check("raw tokens are never returned", !JSON.stringify(list.data).includes(TOKEN_A));
check("one user cannot unregister another's device", (await call("/devices", { method: "DELETE", token: u.token, body: { token: TOKEN_A } })).data?.removed === 0);
check("the device survived that attempt", !!(await db.deviceToken.findUnique({ where: { token: TOKEN_A } })));
check("the owner can unregister it", (await call("/devices", { method: "DELETE", token: v.token, body: { token: TOKEN_A } })).data?.removed === 1);
check("it is gone", !(await db.deviceToken.findUnique({ where: { token: TOKEN_A } })));

console.log("\n--- a real notification fans out to the devices ---");
const w = await mkStaff("three");
await call("/devices", { method: "POST", token: w.token, body: { token: `${TOKEN_A}-w1`, platform: "ios" } });
await call("/devices", { method: "POST", token: w.token, body: { token: `${TOKEN_A}-w2`, platform: "android" } });
check("two devices registered", (await db.deviceToken.count({ where: { staffId: w.id } })) === 2);

// Approving leave notifies the requester — the same path that pushes.
const lv = (await call("/leave", { method: "POST", token: w.token, body: { type: "annual", start: "2026-12-01", end: "2026-12-02", reason: "push probe" } })).data;
const dec = await call(`/leave/${lv.id}/decision`, { method: "PUT", token: admin.token, body: { status: "approved" } });
check("the decision succeeds even though FCM is a stub", dec.status === 200);
await new Promise((r) => setTimeout(r, 600));
const notes = (await call("/notifications", { token: w.token })).data;
check("the in-app notification was still created", notes.some((n) => /was approved/i.test(n.message)));
check("both device tokens are still registered (stub send must not delete them)", (await db.deviceToken.count({ where: { staffId: w.id } })) === 2);

console.log("\n--- deleting an account removes its devices ---");
const d = await mkStaff("four");
await call("/devices", { method: "POST", token: d.token, body: { token: `${TOKEN_A}-d1`, platform: "ios" } });
check("device registered", (await db.deviceToken.count({ where: { staffId: d.id } })) === 1);
check("account deleted", (await call("/auth/account", { method: "DELETE", token: d.token, body: { password: "PushPass123!", confirm: "DELETE" } })).status === 200);
check("its device tokens went with it", (await db.deviceToken.count({ where: { staffId: d.id } })) === 0);

// cleanup
await db.deviceToken.deleteMany({ where: { token: { contains: TAG } } });
await db.leave.deleteMany({ where: { reason: "push probe" } });
for (const email of made) {
  const s = await db.staff.findFirst({ where: { email } });
  if (s) await db.staff.delete({ where: { id: s.id } });
}
await db.notification.deleteMany({ where: { message: { contains: "Push " } } });
await db.$disconnect();
console.log("\ncleanup: probe accounts, devices and notifications removed");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
