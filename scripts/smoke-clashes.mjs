// Clash detection v1 — the report endpoint. The arithmetic has 18 unit tests across
// clashes.js and overlap.js; what an HTTP suite must prove is the wiring and the
// gate:
//
//   1. The page gate: /api/timetabling is requirePage("scheduling"), and a member
//      of staff without it gets 403, not somebody else's double-bookings.
//   2. The report finds a planted staff double-booking, names the resource, and
//      does NOT report the back-to-back pair planted beside it — the boundary rule
//      surviving the whole pipe, not just the unit tests.
//   3. Range validation refuses garbage before touching the database.
//
//   node scripts/smoke-clashes.mjs
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(pathToFileURL(join(ROOT, "server", "package.json")));
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — point it at a throwaway database."); process.exit(1); }
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const BASE = process.env.API_URL || "http://localhost:4010/api";
const ADMIN = process.env.SEED_ADMIN_EMAIL || "admin@edtech.co.uk";
const PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";

let passed = 0, failed = 0;
const ok = (label, detail) => { passed++; console.log(`✓ ${label}${detail ? "  — " + detail : ""}`); };
const bad = (label, e) => { failed++; console.log(`✗ ${label}\n    ${e && e.message ? e.message : e}`); };
async function check(label, fn) { try { const d = await fn(); ok(label, d); } catch (e) { bad(label, e); } }
const call = async (path, { method = "GET", body, token } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
};

console.log("\n=== timetable clashes ===\n");

const admin = await call("/auth/login", { method: "POST", body: { email: ADMIN, password: PASSWORD } });
if (!admin.body.token) { console.log("✗ could not sign in as the seeded admin"); process.exit(1); }
const adminToken = admin.body.token;

const probe = await call("/timetabling/clashes?from=2031-01-06&to=2031-01-06", { token: adminToken });
if (probe.status === 404) { console.log("SKIP — /api/timetabling/clashes is not in this build"); process.exit(2); }

const stamp = Date.now();
const made = { staff: [], events: [] };
// A far-future week nothing else schedules into, so the counts are exactly ours.
const DAY = "2031-01-06";

async function makeStaff(name, email, pw, pages) {
  const r = await call("/staff", { method: "POST", token: adminToken, body: { name, email, password: pw } });
  if (!r.body?.id) { console.log(`✗ could not create fixture ${email}`); process.exit(1); }
  await db.staff.update({ where: { id: r.body.id }, data: { mustChangePassword: false, ...(pages ? { accountRole: "ADMIN", adminPages: JSON.stringify(pages) } : {}) } });
  const login = await call("/auth/login", { method: "POST", body: { email, password: pw } });
  made.staff.push(r.body.id);
  return { id: r.body.id, token: login.body?.token };
}

const lecturer = await makeStaff("Doubly Booked", `cl.staff.${stamp}@edtech.co.uk`, "ClashPass123!", null);
const nobody = await makeStaff("No Pages", `cl.none.${stamp}@edtech.co.uk`, "NonePass123!", null);

async function makeEvent(startTime, endTime, staffId) {
  const ev = await db.timetableEvent.create({ data: { date: DAY, startTime, endTime, title: `Clash fixture ${startTime}`, published: true } });
  if (staffId) await db.timetableEventStaff.create({ data: { eventId: ev.id, staffId } });
  made.events.push(ev.id);
  return ev;
}

// The planted picture: 09:00–11:00 and 10:00–12:00 share the lecturer (a clash);
// 13:00–14:00 and 14:00–15:00 share them back-to-back (NOT a clash).
await makeEvent("09:00", "11:00", lecturer.id);
await makeEvent("10:00", "12:00", lecturer.id);
await makeEvent("13:00", "14:00", lecturer.id);
await makeEvent("14:00", "15:00", lecturer.id);

try {
  await check("a member of staff without the scheduling page is refused the report", async () => {
    const r = await call(`/timetabling/clashes?from=${DAY}&to=${DAY}`, { token: nobody.token });
    assert.equal(r.status, 403, `HTTP ${r.status}`);
  });

  await check("garbage dates are refused before the database is asked anything", async () => {
    const r = await call("/timetabling/clashes?from=nonsense&to=alsono", { token: adminToken });
    assert.equal(r.status, 400, `HTTP ${r.status}`);
  });

  await check("the planted double-booking is found and named; the back-to-back pair is not", async () => {
    const r = await call(`/timetabling/clashes?from=${DAY}&to=${DAY}`, { token: adminToken });
    assert.equal(r.status, 200, `HTTP ${r.status}`);
    assert.equal(r.body.total, 1, `total=${r.body.total}: ${JSON.stringify(r.body.clashes).slice(0, 300)}`);
    const c = r.body.clashes[0];
    assert.equal(c.kind, "staff");
    assert.equal(c.resourceName, "Doubly Booked");
    assert.equal(c.from, "10:00");
    assert.equal(c.to, "11:00");
    return `${c.resourceName}: ${c.from}–${c.to}`;
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
} catch (e) {
  console.error("suite error:", e);
  process.exitCode = 1;
} finally {
  await db.timetableEvent.deleteMany({ where: { id: { in: made.events } } });
  await db.staff.deleteMany({ where: { id: { in: made.staff } } });
  await db.$disconnect();
}
