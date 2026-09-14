// Cohort-scale stress: N students (default 1000) SIGN IN at the same moment, then
// SCAN the same class's QR at the same moment. Companion to stress-qr.mjs, which
// covers correctness under abuse; this one measures the platform under a whole
// intake arriving at 09:00.
//
// What it can and cannot claim: it drives ONE local API process against ONE local
// Postgres, so the absolute numbers are this laptop's, not Render's. The SHAPE
// transfers: login cost is dominated by bcrypt, which this server runs
// synchronously on the event loop (STRESS-TEST.md has carried that ceiling since
// July), so a login wave serialises — expect throughput near 1000/(N×hash-cost)
// and a brutal p99 — while the scan wave, which does no hashing, shows what the
// same server does when the event loop is free.
//
//   API_URL=http://localhost:4026/api DATABASE_URL=... JWT_SECRET=... \
//     [STRESS_N=1000] node scripts/stress-login.mjs
//   (the API must be booted with the SAME JWT_SECRET; throwaway database ONLY.)
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const server = join(ROOT, "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);
const bcrypt = require(`${ROOT}/server/node_modules/bcryptjs`);
const { deriveCode, windowIndexFor } = require(join(server, "src", "attendanceQr.js"));
const { qrSigningKey } = require(join(server, "src", "secrets.js"));

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — a THROWAWAY database."); process.exit(1); }
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const BASE = process.env.API_URL || "http://localhost:4026/api";
const N = Math.max(50, Math.min(5000, Number(process.env.STRESS_N) || 1000));
const SECRET = qrSigningKey();

const call = async (path, body, token) => {
  const t0 = performance.now();
  try {
    const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})), ms: performance.now() - t0 };
  } catch (e) {
    // status 0 = the request never got an HTTP reply. `err` is the reason (undici's
    // code) — the difference between "the SERVER refused" and "MY client's connection
    // pool melted firing N sockets at once", which are entirely different findings.
    return { status: 0, err: e?.cause?.code || e?.code || e?.message || "?", ms: performance.now() - t0 };
  }
};
// Fire `items` through `fn` at a bounded CONCURRENCY, so the numbers measure the
// server rather than how many sockets one Node process can open at once. A pool of
// workers pulling from a shared cursor.
async function pooled(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); }
  }));
  return out;
}
const errBreakdown = (rs) => {
  const m = {};
  for (const r of rs) { const k = r.status === 0 ? `err:${r.err}` : r.status + (r.body?.reason ? ":" + r.body.reason : ""); m[k] = (m[k] || 0) + 1; }
  return JSON.stringify(m);
};
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p) => Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
  return `p50 ${at(50)}ms · p95 ${at(95)}ms · p99 ${at(99)}ms · max ${Math.round(s[s.length - 1])}ms`;
};

console.log(`\n=== cohort stress: ${N} students ===\n`);

const cfgRow = await db.attendanceTapConfig.findFirst();
const ROTATE = Number(cfgRow?.settings?.qrRotateSeconds) >= 10 ? Number(cfgRow.settings.qrRotateSeconds) : 20;
const codeNow = (sessionId) =>
  deriveCode({ secret: SECRET, sessionId, windowIndex: windowIndexFor(Math.floor(Date.now() / 1000), ROTATE) });

/* ----------------------------- fixtures (bulk) ------------------------------ */

const stamp = Date.now();
const TZ = process.env.APP_TIMEZONE || "Europe/London";
const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const hhmm = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });

const unit = await db.unit.create({ data: { code: `ZZKS-${stamp}`, name: "Cohort Stress Unit", unitNumber: "", tutor: "" } });
// A whole-day window: withinSessionWindow works in minutes-since-midnight and does not
// model a class that crosses midnight, so an end computed as now+Nmin wraps below the
// start when the harness runs late in the evening and every scan reads "not running"
// (a real harness bug, seen once). "00:05"–"23:55" contains any realistic run time.
const session = await db.hndSession.create({ data: { unitId: unit.id, date: dateStr, startTime: "00:05", endTime: "23:55", description: "cohort stress" } });
void hhmm;

// One hash shared by everyone: the harness measures the SERVER's bcrypt, not ours.
const pwHash = bcrypt.hashSync("CohortPass123!", 10) // cost 10, matching server auth.js hashPassword — compare() runs at the STORED cost, so a cheaper seed would measure a login the server never performs;
console.log(`seeding ${N} students…`);
const t0seed = performance.now();
await db.student.createMany({ data: Array.from({ length: N }, (_, i) => ({
  id: `zzks-${stamp}-${i}`,
  firstName: "Cohort", lastName: `K${String(i).padStart(4, "0")}`,
  studentRef: `K${stamp % 1e7}${String(i).padStart(4, "0")}`,
  email: `ks.${stamp}.${i}@edtech.co.uk`, initials: "CK", colour: "#1a3a8f", passwordHash: pwHash,
})) });
await db.enrolment.createMany({ data: Array.from({ length: N }, (_, i) => ({ studentId: `zzks-${stamp}-${i}`, unitId: unit.id })) });
console.log(`seeded in ${Math.round(performance.now() - t0seed)}ms`);

const emails = Array.from({ length: N }, (_, i) => `ks.${stamp}.${i}@edtech.co.uk`);
try {
  /* WAVE 1a — the thundering herd: all N logins fired at literally once. This is the
     worst case the user asked for, and it characterises the CEILING, not the
     sustainable rate. Synchronous bcrypt on the event loop means logins serialise;
     everything past the connection backlog errors at the socket. */
  console.log(`\nWAVE 1a — ${N} logins fired simultaneously (the herd)…`);
  let t0 = performance.now();
  const herd = await Promise.all(emails.map((email) => call("/auth/login", { email, password: "CohortPass123!" })));
  let wall = performance.now() - t0;
  const herdOk = herd.filter((r) => r.status === 200 && r.body.token).length;
  console.log(`  ${herdOk}/${N} signed in · wall ${Math.round(wall)}ms`);
  console.log(`  latency ${stats(herd.map((r) => r.ms))}`);
  console.log(`  outcomes ${errBreakdown(herd)}`);

  /* WAVE 1b — the same N logins at a bounded concurrency of 50. This measures the
     SERVER's real sustained login throughput, undistorted by one Node client trying
     to hold a thousand sockets. Every one must succeed; the tokens feed wave 2. */
  console.log(`\nWAVE 1b — the same ${N} logins, 50 at a time (sustained rate)…`);
  t0 = performance.now();
  const logins = await pooled(emails, 50, (email) => call("/auth/login", { email, password: "CohortPass123!" }));
  wall = performance.now() - t0;
  console.log(`  ${logins.filter((r) => r.status === 200 && r.body.token).length}/${N} signed in · wall ${Math.round(wall)}ms · ${Math.round(N / (wall / 1000))} logins/s sustained`);
  console.log(`  latency ${stats(logins.map((r) => r.ms))}`);
  if (logins.some((r) => !(r.status === 200 && r.body.token))) console.log(`  outcomes ${errBreakdown(logins)}`);
  // A few connections RESET under a 169-second cost-10 hammer — a saturation symptom,
  // not a rejection: the server answered every request it accepted. Retry the
  // stragglers gently so the scan wave (the headline) gets its full set of tokens; a
  // login that still fails after a calm retry would be a real failure.
  const failedIdx = logins.map((r, i) => (r.status === 200 && r.body.token ? -1 : i)).filter((i) => i >= 0);
  if (failedIdx.length) {
    console.log(`  retrying ${failedIdx.length} straggler(s) gently…`);
    await pooled(failedIdx, 5, async (i) => { logins[i] = await call("/auth/login", { email: emails[i], password: "CohortPass123!" }); });
  }
  const okL = logins.filter((r) => r.status === 200 && r.body.token);
  assert.equal(okL.length, N, `${N - okL.length} logins still failed after a calm retry — a real failure, not a ceiling`);

  /* WAVE 2 — the headline. N already-authenticated students scan the SAME class at
     once. This is the operation that actually repeats every lecture and it does NO
     bcrypt, so it shows what the server does when the event loop is free. Bounded at
     100 concurrent for the same client-isolation reason; codes derived at fire time. */
  console.log(`\nWAVE 2 — ${N} simultaneous QR scans (100 at a time)…`);
  const tokens = logins.map((r) => r.body.token);
  t0 = performance.now();
  const scans = await pooled(tokens, 100, (tok) => call("/student/me/qr-check-in", { sessionId: session.id, code: codeNow(session.id) }, tok));
  wall = performance.now() - t0;
  const okS = scans.filter((r) => r.status === 201);
  console.log(`  ${okS.length}/${N} marked · wall ${Math.round(wall)}ms · ${Math.round(N / (wall / 1000))} scans/s`);
  console.log(`  latency ${stats(scans.map((r) => r.ms))}`);
  console.log(`  outcomes ${errBreakdown(scans)}`);
  const marks = await db.attendanceMark.count({ where: { sessionId: session.id } });
  console.log(`  marks in the register: ${marks}`);
  // The one hard correctness invariant, whatever the load did: one row per 201, and
  // every student who got a 201 has exactly one mark — no double-marks under the surge.
  assert.equal(marks, okS.length, `${okS.length} scans reported success but ${marks} rows exist`);
  const overMarked = await db.attendanceMark.groupBy({ by: ["studentId"], where: { sessionId: session.id }, _count: true, having: { studentId: { _count: { gt: 1 } } } });
  assert.equal(overMarked.length, 0, `${overMarked.length} students were marked more than once`);
  console.log(`\nCORRECTNESS HELD: ${marks} rows, ${okS.length} successes, 0 double-marks. Numbers above are this machine's.`);
} catch (e) {
  console.error("harness error:", e);
  process.exitCode = 1;
} finally {
  console.log("\ncleaning up…");
  await db.tagTap.deleteMany({ where: { student: { studentRef: { startsWith: `K${stamp % 1e7}` } } } }).catch(() => {});
  await db.attendanceMark.deleteMany({ where: { sessionId: session.id } });
  await db.enrolment.deleteMany({ where: { unitId: unit.id } });
  await db.hndSession.delete({ where: { id: session.id } }).catch(() => {});
  await db.unit.delete({ where: { id: unit.id } }).catch(() => {});
  await db.student.deleteMany({ where: { id: { startsWith: `zzks-${stamp}-` } } });
  await db.$disconnect();
  console.log("done");
}
