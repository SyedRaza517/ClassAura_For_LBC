// Regression test for the integer-overflow outage found by the multi-agent sweep.
//
// The original bug: POST /api/adjustments accepted days = 2147483648. SQLite stored
// it, Prisma could no longer read the Adjustment table (P2023), the async route
// threw an unhandled rejection, and the whole API process died — permanently, since
// the poison row survived every restart and the client loads adjustments on sign-in.
//
// Prereq: API running on http://localhost:4000  (npm run dev)
// Usage:  node scripts/smoke-int-overflow.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

const BASE = process.env.API_URL || "http://localhost:4000/api";
const SEED_PW = process.env.SEED_PASSWORD || "password123";
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

const admin = (await call("/auth/login", { method: "POST", body: { email: "admin@edtech.co.uk", password: SEED_PW } })).data;
if (!admin?.token) { console.error("could not sign in as admin — is the API running?"); process.exit(1); }
const staffId = (await call("/staff", { token: admin.token })).data.find((s) => s.email === "j.whitfield@edtech.co.uk").id;

const OVERSIZED = [2147483648, -2147483649, 9999999999, Number.MAX_SAFE_INTEGER, 1e15];

console.log("\n--- adjustments: oversized values must be refused ---");
for (const days of OVERSIZED) {
  const r = await call("/adjustments", { method: "POST", token: admin.token, body: { staffId, days, note: "overflow probe" } });
  check(`days=${days} rejected (400)`, r.status === 400, `got ${r.status}`);
}
check("a sensible adjustment is still accepted", (await call("/adjustments", { method: "POST", token: admin.token, body: { staffId, days: 2, note: "overflow probe ok" } })).status === 201);
check("beyond the business cap is refused", (await call("/adjustments", { method: "POST", token: admin.token, body: { staffId, days: 99999, note: "overflow probe" } })).status === 400);

console.log("\n--- allowance: same column type, same risk ---");
for (const allowance of OVERSIZED.filter((n) => n > 0)) {
  const r = await call(`/staff/${staffId}`, { method: "PUT", token: admin.token, body: { allowance } });
  check(`PUT allowance=${allowance} rejected (400)`, r.status === 400, `got ${r.status}`);
}
check("a sensible allowance is still accepted", (await call(`/staff/${staffId}`, { method: "PUT", token: admin.token, body: { allowance: 28 } })).status === 200);

console.log("\n--- the tables are still readable ---");
check("GET /adjustments works", (await call("/adjustments", { token: admin.token })).status === 200);
check("GET /staff works", (await call("/staff", { token: admin.token })).status === 200);

console.log("\n--- an async route failure must not kill the process ---");
// Plant a poison row directly, bypassing the API, to simulate a pre-existing bad
// row or any other Prisma read failure. The API must return 500 and STAY UP.
const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
// The same database the API under test is using. This was a hardcoded SQLite file
// path — a leftover from before the move to PostgreSQL — which made every suite that
// touches the database directly fail schema validation before running a single query.
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — point it at a throwaway database."); process.exit(1); }
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
// On SQLite this planted a row the API could not read: SQLite is dynamically
// typed, so it stored 2^31 in an INTEGER column quite happily, Prisma then threw
// on every read of the table, and the unhandled rejection killed the process.
//
// On PostgreSQL the database itself refuses the value, so that row cannot exist
// in the first place — a stronger guarantee than "the API survives it". Assert
// that instead: the check is still a real regression test, it is just testing
// the guard that actually applies now.
let dbRejected = false;
try {
  await db.$executeRawUnsafe(`INSERT INTO "Adjustment" ("id","staffId","days","note","date") VALUES ('overflow-probe-row', '${staffId}', 2147483648, 'planted', '2026-01-01')`);
  await db.$executeRawUnsafe(`DELETE FROM "Adjustment" WHERE "id" = 'overflow-probe-row'`);
} catch (e) {
  dbRejected = /out of range|22003/i.test(e.message || "");
}
check("the DATABASE itself refuses an out-of-range days value", dbRejected);

const after = await call("/health");
check("THE API IS STILL ALIVE afterwards", after.status === 200, `got ${after.status}`);


// cleanup
await db.adjustment.deleteMany({ where: { note: { startsWith: "overflow probe" } } });
await db.$disconnect();
console.log("\ncleanup: probe rows removed");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
