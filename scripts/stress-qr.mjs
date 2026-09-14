// Stress and abuse testing for the student QR check-in path — the register's most
// public write. Run against a THROWAWAY database and a local API only; it creates a
// cohort, hammers /student/me/qr-check-in from every angle a lecture hall (or an
// abuser) produces, and asserts the properties the feature's honesty rests on:
//
//   S1  RACE      one student, 25 identical scans in parallel  -> exactly ONE mark
//   S2  REPEAT    one marked student, 100 re-scans             -> never rate-limited
//                 (idempotent repeats refund their charge), still one mark
//   S3  ABUSE     one student, 30 garbage codes                -> limiter bites at 11,
//                 zero marks (junk gets NO refund)
//   S4  SURGE     a 55-student cohort scanning at once         -> all marked, latency
//   S5  FORGERY   session A's code presented for session B     -> refused, no mark
//   S6  EXPIRED   a two-windows-old code                       -> "expired" unmarked,
//                 "already checked in" once marked
//
//   API_URL=http://localhost:4025/api DATABASE_URL=... JWT_SECRET=... node scripts/stress-qr.mjs
//   (the API must be booted with the SAME JWT_SECRET — codes are derived locally.)
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
const BASE = process.env.API_URL || "http://localhost:4025/api";
const SECRET = qrSigningKey();

let passed = 0, failed = 0;
const ok = (label, detail) => { passed++; console.log(`✓ ${label}${detail ? "  — " + detail : ""}`); };
const bad = (label, e) => { failed++; console.log(`✗ ${label}\n    ${e && e.message ? e.message : e}`); };
const check = async (label, fn) => { try { const d = await fn(); ok(label, d); } catch (e) { bad(label, e); } };
const call = async (path, { method = "GET", body, token } = {}) => {
  const t0 = performance.now();
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, body: json, ms: performance.now() - t0 };
};
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]); };

console.log("\n=== QR check-in stress ===\n");

// The rotation the API is actually using, so derived codes land in the right window.
const cfgRow = await db.attendanceTapConfig.findFirst();
const ROTATE = Number(cfgRow?.settings?.qrRotateSeconds) >= 10 ? Number(cfgRow.settings.qrRotateSeconds) : 20;
const codeFor = (sessionId, offsetWindows = 0) =>
  deriveCode({ secret: SECRET, sessionId, windowIndex: windowIndexFor(Math.floor(Date.now() / 1000), ROTATE) + offsetWindows });
// A code derived at a window's tail is a different window by the time the API reads its
// clock — wait out the last two seconds so the parallel batches are deterministic.
const avoidBoundary = async () => {
  const into = Math.floor(Date.now() / 1000) % ROTATE;
  if (into >= ROTATE - 3) await new Promise((r) => setTimeout(r, (ROTATE - into + 1) * 1000));
};

/* ----------------------------- fixtures ----------------------------------- */

const stamp = Date.now();
const N = 60;
const localDatePart = new Date().toLocaleDateString("en-CA", { timeZone: process.env.APP_TIMEZONE || "Europe/London" });
const hhmm = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: process.env.APP_TIMEZONE || "Europe/London" });
const start = hhmm(new Date(Date.now() - 30 * 60000)), end = hhmm(new Date(Date.now() + 120 * 60000));

const made = { students: [], units: [], sessions: [] };
const unitA = await db.unit.create({ data: { code: `ZZQS-${stamp}`, name: "QR Stress Unit A", unitNumber: "", tutor: "" } });
const unitB = await db.unit.create({ data: { code: `ZZQT-${stamp}`, name: "QR Stress Unit B", unitNumber: "", tutor: "" } });
made.units.push(unitA.id, unitB.id);
const sessionA = await db.hndSession.create({ data: { unitId: unitA.id, date: localDatePart, startTime: start, endTime: end, description: "stress A" } });
const sessionB = await db.hndSession.create({ data: { unitId: unitB.id, date: localDatePart, startTime: start, endTime: end, description: "stress B" } });
made.sessions.push(sessionA.id, sessionB.id);

const pwHash = bcrypt.hashSync("StressPass123!", 8);
console.log(`creating ${N} students…`);
for (let i = 0; i < N; i++) {
  const s = await db.student.create({ data: {
    firstName: "Stress", lastName: `S${String(i).padStart(2, "0")}`,
    studentRef: `ZZQS${stamp}${i}`.slice(0, 20),
    email: `qs.${stamp}.${i}@edtech.co.uk`, initials: "QS", colour: "#1a3a8f", passwordHash: pwHash,
  }});
  made.students.push(s.id);
  await db.enrolment.create({ data: { unitId: unitA.id, studentId: s.id } });
}
await db.enrolment.create({ data: { unitId: unitB.id, studentId: made.students[59] } });

console.log("signing 60 students in…");
const tokens = [];
for (let i = 0; i < N; i += 12) {
  const batch = await Promise.all(Array.from({ length: Math.min(12, N - i) }, (_, j) =>
    call("/auth/login", { method: "POST", body: { email: `qs.${stamp}.${i + j}@edtech.co.uk`, password: "StressPass123!" } })));
  batch.forEach((r) => tokens.push(r.body.token));
}
assert.ok(tokens.every(Boolean), "every student must sign in");

const marksOn = (sessionId) => db.attendanceMark.count({ where: { sessionId } });
const scan = (i, sessionId, code) => call("/student/me/qr-check-in", { method: "POST", token: tokens[i], body: { sessionId, code } });

try {
  /* S1 — the race */
  await avoidBoundary();
  await check("S1 RACE: 25 parallel identical scans write exactly ONE mark, no 500s", async () => {
    const code = codeFor(sessionA.id);
    const rs = await Promise.all(Array.from({ length: 25 }, () => scan(0, sessionA.id, code)));
    const codes = rs.map((r) => r.status);
    assert.ok(codes.every((c) => c === 200 || c === 201 || c === 429), `unexpected statuses ${[...new Set(codes)]}`);
    assert.equal(codes.filter((c) => c >= 500).length, 0);
    const marks = await db.attendanceMark.count({ where: { sessionId: sessionA.id, studentId: made.students[0] } });
    assert.equal(marks, 1, `marks=${marks}`);
    return `statuses: ${JSON.stringify(Object.fromEntries([...new Set(codes)].map((c) => [c, codes.filter(x => x === c).length])))}`;
  });

  /* S2 — the repeat storm */
  await check("S2 REPEAT: 100 re-scans of a marked student never hit the limiter, still one mark", async () => {
    await avoidBoundary();
    const first = await scan(1, sessionA.id, codeFor(sessionA.id));
    assert.ok(first.status === 201 || first.status === 200, `first scan HTTP ${first.status}`);
    let limited = 0;
    for (let k = 0; k < 100; k++) {
      const r = await scan(1, sessionA.id, codeFor(sessionA.id));
      if (r.status === 429) limited++;
      else { assert.equal(r.status, 200, `repeat ${k}: HTTP ${r.status}`); assert.equal(r.body.alreadyMarked, true); }
    }
    assert.equal(limited, 0, `${limited} repeats were rate-limited — the refund is not holding`);
    const marks = await db.attendanceMark.count({ where: { sessionId: sessionA.id, studentId: made.students[1] } });
    assert.equal(marks, 1);
  });

  /* S3 — the abuser */
  await check("S3 ABUSE: garbage codes get no refund — the limiter bites at attempt 11, zero marks", async () => {
    const rs = [];
    for (let k = 0; k < 30; k++) rs.push(await scan(2, sessionA.id, "AAAAAAAAAAAAAAAAAAAAAA"));
    const first10 = rs.slice(0, 10).map((r) => r.status);
    const rest = rs.slice(10).map((r) => r.status);
    assert.ok(first10.every((c) => c === 404), `first ten: ${[...new Set(first10)]}`);
    assert.ok(rest.every((c) => c === 429), `after ten: ${[...new Set(rest)]}`);
    assert.equal(await db.attendanceMark.count({ where: { studentId: made.students[2] } }), 0);
  });

  /* S4 — the lecture hall */
  await avoidBoundary();
  await check("S4 SURGE: 55 students scan at once — everyone marked, and how fast", async () => {
    const code = codeFor(sessionA.id);
    const idx = Array.from({ length: 55 }, (_, j) => j + 3);
    const rs = await Promise.all(idx.map((i) => scan(i, sessionA.id, code)));
    const bad = rs.filter((r) => r.status !== 201);
    assert.equal(bad.length, 0, `${bad.length} of 55 failed: ${[...new Set(bad.map((r) => r.status + ":" + (r.body.reason || "")))]}`);
    const marks = await db.attendanceMark.count({ where: { sessionId: sessionA.id, studentId: { in: idx.map((i) => made.students[i]) } } });
    assert.equal(marks, 55);
    const times = rs.map((r) => r.ms);
    return `p50 ${pct(times, 50)}ms · p95 ${pct(times, 95)}ms · max ${Math.round(Math.max(...times))}ms`;
  });

  /* S5 — the forger */
  await check("S5 FORGERY: session A's live code presented for session B is refused, writes nothing", async () => {
    const r = await scan(59, sessionB.id, codeFor(sessionA.id));
    assert.equal(r.status, 404, `HTTP ${r.status} (${r.body.reason})`);
    assert.equal(r.body.reason, "qr_bad_code");
    assert.equal(await marksOn(sessionB.id), 0);
  });

  /* S6 — the stale screen */
  await check("S6 EXPIRED: a two-windows-old code says 'expired' unmarked, 'already in' once marked", async () => {
    const stale = () => codeFor(sessionB.id, -2);
    const before = await scan(59, sessionB.id, stale());
    assert.equal(before.status, 409, `unmarked: HTTP ${before.status} (${before.body.reason})`);
    assert.equal(before.body.reason, "qr_expired");
    await avoidBoundary();
    const markIt = await scan(59, sessionB.id, codeFor(sessionB.id));
    assert.ok(markIt.status === 201, `marking: HTTP ${markIt.status}`);
    const after = await scan(59, sessionB.id, stale());
    assert.equal(after.status, 200, `marked: HTTP ${after.status}`);
    assert.equal(after.body.alreadyMarked, true);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
} catch (e) {
  console.error("harness error:", e);
  process.exitCode = 1;
} finally {
  await db.tagTap.deleteMany({ where: { studentId: { in: made.students } } });
  await db.attendanceMark.deleteMany({ where: { sessionId: { in: made.sessions } } });
  await db.hndSession.deleteMany({ where: { id: { in: made.sessions } } });
  await db.unit.deleteMany({ where: { id: { in: made.units } } });
  await db.student.deleteMany({ where: { id: { in: made.students } } });
  await db.$disconnect();
}
