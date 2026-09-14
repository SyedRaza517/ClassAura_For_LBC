// The insights feed — and, as ever, mostly who is told what. Two gates carry it:
//
//   1. IDENTITY: a lecturer's cards are computed over the students of units that
//      name them, and nobody else's. The stranger's assertion is the one that
//      matters — an empty feed for staff with no classes and no pages is a TRUE
//      answer, and a stale-attendance card leaking to someone who teaches nobody
//      is a student's name where it has no business being.
//   2. PAGES: the admin aggregates ride per-card page requirements. A lecturer
//      holding no admin pages must not receive the leave backlog card however
//      real the backlog is.
//
// Plus the null rule the cards module enforces: a student never marked is not
// "unseen", so the fixture includes one and asserts their absence.
//
//   node scripts/smoke-suggestions.mjs
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(pathToFileURL(join(ROOT, "server", "package.json")));
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);
const bcrypt = require(`${ROOT}/server/node_modules/bcryptjs`);
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — point it at a throwaway database."); process.exit(1); }
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const BASE = process.env.API_URL || "http://localhost:4010/api";
const ADMIN = process.env.SEED_ADMIN_EMAIL || "admin@edtech.co.uk";
const PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";

let passed = 0, failed = 0;
const ok = (label, detail) => { passed++; console.log(`✓ ${label}${detail ? "  — " + detail : ""}`); };
const bad = (label, e) => { failed++; console.log(`✗ ${label}\n    ${e && e.message ? e.message : e}`); };
async function check(label, fn) {
  try { const d = await fn(); ok(label, d); } catch (e) { bad(label, e); }
}
const call = async (path, { method = "GET", body, token } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
};
const isoDaysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

console.log("\n=== suggestions ===\n");

const admin = await call("/auth/login", { method: "POST", body: { email: ADMIN, password: PASSWORD } });
if (!admin.body.token) { console.log("✗ could not sign in as the seeded admin"); process.exit(1); }
const adminToken = admin.body.token;

const probe = await call("/suggestions", { token: adminToken });
if (probe.status === 404) { console.log("SKIP — /api/suggestions is not mounted in this build"); process.exit(2); }

/* ----------------------------- fixtures ----------------------------------- */

const stamp = Date.now();
const made = { staff: [], students: [], units: [], sessions: [], leave: [] };

async function makeStaff(name, email, pw) {
  const r = await call("/staff", { method: "POST", token: adminToken, body: { name, email, password: pw } });
  if (!r.body?.id) { console.log(`✗ could not create fixture ${email}`); process.exit(1); }
  await db.staff.update({ where: { id: r.body.id }, data: { mustChangePassword: false } });
  const login = await call("/auth/login", { method: "POST", body: { email, password: pw } });
  made.staff.push(r.body.id);
  return { id: r.body.id, token: login.body?.token };
}
async function makeStudent(suffix, first) {
  const s = await db.student.create({ data: {
    firstName: first, lastName: `Suggest${suffix}`, studentRef: `ZZSG${stamp}${suffix}`.slice(0, 20),
    email: `sg.${stamp}.${suffix}@edtech.co.uk`.toLowerCase(), initials: "SG", colour: "#1a3a8f",
    passwordHash: bcrypt.hashSync("StudentPass123!", 10),
  }});
  made.students.push(s.id);
  return s;
}

const tutor = await makeStaff("Suggesting Tutor", `sg.tutor.${stamp}@edtech.co.uk`, "TutorPass123!");
const stranger = await makeStaff("Unrelated Staff", `sg.none.${stamp}@edtech.co.uk`, "NonePass123!");

const unit = await db.unit.create({ data: { code: `ZZSG-${stamp}`, name: "Suggestion Fixture Unit", unitNumber: "", tutor: "", tutorStaffId: tutor.id } });
made.units.push(unit.id);
// Ghost: enrolled, NEVER marked — must never be reported "unseen".
// Gone: last present 20 days ago. Here: present yesterday.
const [gone, here, ghost] = [await makeStudent("A", "Gonzalo"), await makeStudent("B", "Hermione"), await makeStudent("C", "Ghislaine")];
for (const s of [gone, here, ghost]) await db.enrolment.create({ data: { unitId: unit.id, studentId: s.id } });

const oldSession = await db.hndSession.create({ data: { unitId: unit.id, date: isoDaysAgo(20), startTime: "09:00", endTime: "10:00" } });
const newSession = await db.hndSession.create({ data: { unitId: unit.id, date: isoDaysAgo(1), startTime: "09:00", endTime: "10:00" } });
made.sessions.push(oldSession.id, newSession.id);
await db.attendanceMark.create({ data: { sessionId: oldSession.id, studentId: gone.id, status: "P", takenBy: "fixture" } });
await db.attendanceMark.create({ data: { sessionId: oldSession.id, studentId: here.id, status: "P", takenBy: "fixture" } });
await db.attendanceMark.create({ data: { sessionId: newSession.id, studentId: here.id, status: "P", takenBy: "fixture" } });

// A leave request that has sat pending ten days — the admin card's fixture,
// created BEFORE the first admin fetch because the aggregate side caches per boot.
const staleLeave = await db.leave.create({ data: { staffId: stranger.id, type: "annual", start: isoDaysAgo(-20), end: isoDaysAgo(-19), days: 2, reason: "SUGGEST-FIXTURE", status: "pending", requestedAt: isoDaysAgo(10) } });
made.leave.push(staleLeave.id);

const studentLogin = await call("/auth/login", { method: "POST", body: { email: gone.email, password: "StudentPass123!" } });

try {
  await check("a student token is refused outright", async () => {
    assert.ok(studentLogin.body?.token, "student fixture could not sign in");
    const r = await call("/suggestions", { token: studentLogin.body.token });
    assert.equal(r.status, 403, `HTTP ${r.status}`);
  });

  await check("staff with no classes and no pages get an EMPTY feed — a true answer, not an error", async () => {
    const r = await call("/suggestions", { token: stranger.token });
    assert.equal(r.status, 200, `HTTP ${r.status}`);
    assert.deepEqual(r.body.suggestions, [], JSON.stringify(r.body.suggestions).slice(0, 200));
  });

  await check("the tutor is told who has stopped coming — and not told about the never-marked", async () => {
    const r = await call("/suggestions", { token: tutor.token });
    assert.equal(r.status, 200);
    const stale = (r.body.suggestions || []).find((c) => c.kind === "stale-attendance");
    assert.ok(stale, `no stale-attendance card: ${JSON.stringify(r.body.suggestions).slice(0, 200)}`);
    assert.equal(stale.count, 1, `count=${stale.count}`);
    assert.match(stale.detail, /Gonzalo/);
    assert.doesNotMatch(stale.detail, /Hermione/, "the student seen yesterday was reported");
    assert.doesNotMatch(stale.detail, /Ghislaine/, "the NEVER-MARKED student was reported as unseen — unmeasured is not absent");
    assert.equal(stale.screen, "classes");
  });

  await check("admin cards ride page gates: the tutor, holding no pages, gets no leave-backlog card", async () => {
    const r = await call("/suggestions", { token: tutor.token });
    assert.ok(!(r.body.suggestions || []).some((c) => c.kind === "stale-leave"),
      "the leave backlog reached a lecturer with no leave page");
  });

  await check("the admin, who holds the pages, sees the ten-day leave backlog", async () => {
    const r = await call("/suggestions", { token: adminToken });
    assert.equal(r.status, 200);
    const leave = (r.body.suggestions || []).find((c) => c.kind === "stale-leave");
    assert.ok(leave, `no stale-leave card: ${JSON.stringify(r.body.suggestions).slice(0, 300)}`);
    // The seeded database may hold pending leave far older than this suite's ten-day
    // fixture, and the card reports the OLDEST — so the assertion is that a backlog
    // at least as old as ours is reported, not that ours is the oldest thing alive.
    const days = Number((leave.detail.match(/waited (\d+) day/) || [])[1]);
    assert.ok(Number.isFinite(days) && days >= 10, 'detail: ' + leave.detail);
  });

  await check("a card is an exact key set — the shape cannot grow a field unreviewed", async () => {
    const r = await call("/suggestions", { token: tutor.token });
    const c = (r.body.suggestions || [])[0];
    assert.ok(c, "no card to inspect");
    assert.deepEqual(Object.keys(c).sort(), ["count", "detail", "kind", "screen", "severity", "title"]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
} catch (e) {
  console.error("suite error:", e);
  process.exitCode = 1;
} finally {
  await db.attendanceMark.deleteMany({ where: { sessionId: { in: made.sessions } } });
  await db.hndSession.deleteMany({ where: { id: { in: made.sessions } } });
  await db.leave.deleteMany({ where: { id: { in: made.leave } } });
  await db.unit.deleteMany({ where: { id: { in: made.units } } });
  await db.student.deleteMany({ where: { id: { in: made.students } } });
  await db.staff.deleteMany({ where: { id: { in: made.staff } } });
  await db.$disconnect();
}
