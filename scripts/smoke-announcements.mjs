// Announcements — a lecturer messages the students of a unit they teach, and mostly
// who is refused. The feature is identity-gated (no admin page), so the assertions
// that carry the suite are about the identity:
//
//   1. A member of staff who teaches nothing gets an EMPTY unit list and a 403 on
//      send — and a unit id that does not exist answers the SAME 403, because whether
//      a unit is real is not something a stranger to it has standing to learn.
//   2. Delivery is exactly the enrolment list: every enrolled student gets a
//      Notification row (link "inbox"), and a student on another unit gets nothing.
//      "Everyone got it" passes just as happily when everyone-plus-one got it, so the
//      un-enrolled student is the assertion that matters.
//   3. BOTH ways of teaching admit: the module tutor, and a member of staff named on
//      one of the unit's timetable events who tutors nothing (the visiting-lecturer
//      case hnd.js#teachesSession argues for).
//   4. The sender's history is an EXACT KEY SET — an allowlist that grows a field
//      must fail here, same reasoning as the referrals suite.
//   5. The sixth send inside an hour is refused (429), the empty and over-length
//      message are refused (400), and a student token is refused (403).
//
//   node scripts/smoke-announcements.mjs
//   (needs API_URL + DATABASE_URL; the runner supplies both)
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

console.log("\n=== announcements ===\n");

const admin = await call("/auth/login", { method: "POST", body: { email: ADMIN, password: PASSWORD } });
if (!admin.body.token) { console.log("✗ could not sign in as the seeded admin — is the API seeded?"); process.exit(1); }
const adminToken = admin.body.token;

const probe = await call("/announcements/mine", { token: adminToken });
if (probe.status === 404) { console.log("SKIP — /api/announcements is not mounted in this build"); process.exit(2); }

/* ----------------------------- fixtures ----------------------------------- */

const stamp = Date.now();
const made = { staff: [], students: [], units: [], events: [] };

async function makeStaff(name, email, pw) {
  const r = await call("/staff", { method: "POST", token: adminToken, body: { name, email, password: pw } });
  if (!r.body?.id) { console.log(`✗ could not create fixture ${email}`); process.exit(1); }
  await db.staff.update({ where: { id: r.body.id }, data: { mustChangePassword: false } });
  const login = await call("/auth/login", { method: "POST", body: { email, password: pw } });
  if (!login.body?.token) { console.log(`✗ could not sign in as fixture ${email}`); process.exit(1); }
  made.staff.push(r.body.id);
  return { id: r.body.id, token: login.body.token };
}
async function makeStudent(refSuffix) {
  const ref = `ZZAN${stamp}${refSuffix}`.slice(0, 20);
  const s = await db.student.create({ data: {
    firstName: "Announce", lastName: `Fixture${refSuffix}`, studentRef: ref,
    // Lowercased: /auth/login lowercases the SUBMITTED email and matches exactly, so a
    // stored mixed-case address can never sign in.
    email: `an.${stamp}.${refSuffix}@edtech.co.uk`.toLowerCase(), initials: "AF", colour: "#1a3a8f",
    passwordHash: bcrypt.hashSync("StudentPass123!", 10),
  }});
  made.students.push(s.id);
  return s;
}

const tutor = await makeStaff("Announcing Tutor", `an.tutor.${stamp}@edtech.co.uk`, "TutorPass123!");
const named = await makeStaff("Visiting Lecturer", `an.named.${stamp}@edtech.co.uk`, "NamedPass123!");
const stranger = await makeStaff("Uninvolved Staff", `an.none.${stamp}@edtech.co.uk`, "NonePass123!");

const unit = await db.unit.create({ data: { code: `ZZAN-${stamp}`, name: "Announcement Fixture Unit", unitNumber: "", tutor: "", tutorStaffId: tutor.id } });
made.units.push(unit.id);
const [sA, sB, outsider] = [await makeStudent("A"), await makeStudent("B"), await makeStudent("C")];
await db.enrolment.create({ data: { unitId: unit.id, studentId: sA.id } });
await db.enrolment.create({ data: { unitId: unit.id, studentId: sB.id } });
// The outsider is enrolled on NOTHING — the delivery assertion that matters.

// The visiting-lecturer half: named on one of the unit's timetable events, tutors nothing.
const event = await db.timetableEvent.create({ data: { date: "2026-01-05", startTime: "09:00", endTime: "10:00", title: "Fixture event", unitId: unit.id } });
made.events.push(event.id);
await db.timetableEventStaff.create({ data: { eventId: event.id, staffId: named.id } });

// Students sign in through the SAME /auth/login as staff — the isolated second branch
// in routes/auth.js is the only place a student session is issued.
const studentLogin = await call("/auth/login", { method: "POST", body: { email: sA.email, password: "StudentPass123!" } });

try {
  /* ----------------------------- who may, who may not ---------------------- */

  await check("a member of staff who teaches nothing has no units to announce to", async () => {
    const r = await call("/announcements/my-units", { token: stranger.token });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.units, []);
  });

  await check("the module tutor sees the unit, with the reach counted from enrolments", async () => {
    const r = await call("/announcements/my-units", { token: tutor.token });
    const u = (r.body.units || []).find((x) => x.id === unit.id);
    assert.ok(u, "the fixture unit is missing from the tutor's list");
    assert.equal(u.students, 2, `students=${u?.students}`);
    return `${u.code}: ${u.students} students`;
  });

  await check("a lecturer named on the unit's timetable event sees it too, tutoring nothing", async () => {
    const r = await call("/announcements/my-units", { token: named.token });
    assert.ok((r.body.units || []).some((x) => x.id === unit.id), "the event-named lecturer was refused their unit");
  });

  await check("a stranger's send is refused, and an unknown unit answers the SAME refusal", async () => {
    const real = await call("/announcements", { method: "POST", token: stranger.token, body: { unitId: unit.id, message: "hello" } });
    const fake = await call("/announcements", { method: "POST", token: stranger.token, body: { unitId: "no-such-unit", message: "hello" } });
    assert.equal(real.status, 403, `real unit: HTTP ${real.status}`);
    assert.equal(fake.status, 403, `unknown unit: HTTP ${fake.status}`);
    assert.equal(real.body.error, fake.body.error, "the two refusals must be indistinguishable");
  });

  await check("a student token cannot send announcements", async () => {
    assert.ok(studentLogin.body?.token, `student fixture could not sign in: HTTP ${studentLogin.status} ${JSON.stringify(studentLogin.body).slice(0, 160)}`);
    const r = await call("/announcements", { method: "POST", token: studentLogin.body.token, body: { unitId: unit.id, message: "hi" } });
    assert.equal(r.status, 403, `HTTP ${r.status}`);
  });

  /* ----------------------------- the message itself ------------------------ */

  await check("an empty message is refused", async () => {
    const r = await call("/announcements", { method: "POST", token: tutor.token, body: { unitId: unit.id, message: "   " } });
    assert.equal(r.status, 400, `HTTP ${r.status}`);
  });

  await check("a 501-character message is refused, and the refusal names the limit", async () => {
    const r = await call("/announcements", { method: "POST", token: tutor.token, body: { unitId: unit.id, message: "x".repeat(501) } });
    assert.equal(r.status, 400, `HTTP ${r.status}`);
    assert.match(r.body.error || "", /500/);
  });

  /* ----------------------------- delivery ---------------------------------- */

  const MESSAGE = `Room change for the fixture class (${stamp})`;
  await check("the tutor's send answers 201 with the audience it reached", async () => {
    const r = await call("/announcements", { method: "POST", token: tutor.token, body: { unitId: unit.id, message: MESSAGE } });
    assert.equal(r.status, 201, `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`);
    assert.equal(r.body.recipients, 2, `recipients=${r.body.recipients}`);
    assert.equal(r.body.audienceLabel, `${unit.code} — ${unit.name}`);
    return `${r.body.recipients} recipients, ${r.body.delivered} delivered`;
  });

  await check("every enrolled student got the Notification row, link inbox — and ONLY them", async () => {
    const rows = await db.notification.findMany({ where: { message: MESSAGE } });
    const owners = rows.map((n) => n.studentId).sort();
    assert.deepEqual(owners, [sA.id, sB.id].sort(), `owners=${JSON.stringify(owners)}`);
    assert.ok(rows.every((n) => n.link === "inbox" && n.staffId === null), "wrong link or a staff-owned row");
    const strayForOutsider = rows.some((n) => n.studentId === outsider.id);
    assert.equal(strayForOutsider, false, "the un-enrolled student was notified");
  });

  await check("the record freezes the audience as words and a count", async () => {
    const row = await db.announcement.findFirst({ where: { senderId: tutor.id }, orderBy: { createdAt: "desc" } });
    assert.ok(row, "no Announcement row was written");
    assert.equal(row.audienceLabel, `${unit.code} — ${unit.name}`);
    assert.equal(row.recipientCount, 2);
    assert.equal(row.message, MESSAGE);
  });

  await check("the sender's history is an exact key set — an allowlist that grows must fail here", async () => {
    const r = await call("/announcements/mine", { token: tutor.token });
    assert.equal(r.status, 200);
    const mine = (r.body.announcements || []).find((a) => a.message === MESSAGE);
    assert.ok(mine, "the sent announcement is missing from /mine");
    assert.deepEqual(Object.keys(mine).sort(), ["audienceLabel", "createdAt", "id", "message", "recipientCount"]);
  });

  /* ----------------------------- pacing ------------------------------------ */

  await check("the sixth send inside an hour is refused with 429", async () => {
    // One real send has already spent one of the five; four more exhaust the hour.
    for (let i = 0; i < 4; i++) {
      const r = await call("/announcements", { method: "POST", token: tutor.token, body: { unitId: unit.id, message: `pacing filler ${i} ${stamp}` } });
      assert.equal(r.status, 201, `filler ${i}: HTTP ${r.status}`);
    }
    const sixth = await call("/announcements", { method: "POST", token: tutor.token, body: { unitId: unit.id, message: `the sixth ${stamp}` } });
    assert.equal(sixth.status, 429, `HTTP ${sixth.status}`);
    const stray = await db.announcement.findFirst({ where: { message: `the sixth ${stamp}` } });
    assert.equal(stray, null, "the refused send still wrote a record");
  });

  await check("one sender's spent allowance is not another's — the named lecturer still sends", async () => {
    const r = await call("/announcements", { method: "POST", token: named.token, body: { unitId: unit.id, message: `from the visiting lecturer ${stamp}` } });
    assert.equal(r.status, 201, `HTTP ${r.status}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
} catch (e) {
  console.error("suite error:", e);
  process.exitCode = 1;
} finally {
  // Everything stamped, so deletion is exact. Notifications and announcements first
  // (they point at students/staff), then enrolments/events via cascade with the unit,
  // then the people.
  await db.notification.deleteMany({ where: { studentId: { in: made.students } } });
  await db.announcement.deleteMany({ where: { senderId: { in: made.staff } } });
  await db.timetableEvent.deleteMany({ where: { id: { in: made.events } } });
  await db.unit.deleteMany({ where: { id: { in: made.units } } });
  await db.student.deleteMany({ where: { id: { in: made.students } } });
  await db.staff.deleteMany({ where: { id: { in: made.staff } } });
  await db.$disconnect();
}
