// Conduct points — the two-tap behaviour/merit capture, and mostly who is refused
// and what never gets rewritten. The assertions that carry the suite:
//
//   1. The identity gate: a member of staff who teaches nobody is refused, and an
//      unknown student id answers the SAME refusal (whether a student exists is not
//      a stranger's to learn). A student token is refused outright.
//   2. FROZEN HISTORY: relabelling a vocabulary entry must not rewrite the events
//      already logged under its old words — the row is a record of what was given,
//      not a view through today's config.
//   3. THE STUDENT IS TOLD ONLY WHEN THE COLLEGE SAYS SO: the defaults notify
//      nobody, and a Notification row appearing for a default entry is the failure
//      this feature must never have. Switching an entry's notifyStudent on is what
//      creates one.
//   4. Editing the vocabulary is the settings door; reading it is any staff.
//   5. The live register's conductPoints distinguishes "no events ever" (null, no
//      chip) from a real net figure.
//
//   node scripts/smoke-conduct.mjs
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

console.log("\n=== conduct points ===\n");

const admin = await call("/auth/login", { method: "POST", body: { email: ADMIN, password: PASSWORD } });
if (!admin.body.token) { console.log("✗ could not sign in as the seeded admin — is the API seeded?"); process.exit(1); }
const adminToken = admin.body.token;

const probe = await call("/conduct/vocabulary", { token: adminToken });
if (probe.status === 404) { console.log("SKIP — /api/conduct is not mounted in this build"); process.exit(2); }

/* ----------------------------- fixtures ----------------------------------- */

const stamp = Date.now();
const made = { staff: [], students: [], units: [], sessions: [] };

async function makeStaff(name, email, pw) {
  const r = await call("/staff", { method: "POST", token: adminToken, body: { name, email, password: pw } });
  if (!r.body?.id) { console.log(`✗ could not create fixture ${email}`); process.exit(1); }
  await db.staff.update({ where: { id: r.body.id }, data: { mustChangePassword: false } });
  const login = await call("/auth/login", { method: "POST", body: { email, password: pw } });
  if (!login.body?.token) { console.log(`✗ could not sign in as fixture ${email}`); process.exit(1); }
  made.staff.push(r.body.id);
  return { id: r.body.id, token: login.body.token };
}
async function makeStudent(suffix) {
  const s = await db.student.create({ data: {
    firstName: "Conduct", lastName: `Fixture${suffix}`, studentRef: `ZZCO${stamp}${suffix}`.slice(0, 20),
    email: `co.${stamp}.${suffix}@edtech.co.uk`.toLowerCase(), initials: "CF", colour: "#1a3a8f",
    passwordHash: bcrypt.hashSync("StudentPass123!", 10),
  }});
  made.students.push(s.id);
  return s;
}

const tutor = await makeStaff("Conduct Tutor", `co.tutor.${stamp}@edtech.co.uk`, "TutorPass123!");
const stranger = await makeStaff("Uninvolved Staff", `co.none.${stamp}@edtech.co.uk`, "NonePass123!");

const unit = await db.unit.create({ data: { code: `ZZCO-${stamp}`, name: "Conduct Fixture Unit", unitNumber: "", tutor: "", tutorStaffId: tutor.id } });
made.units.push(unit.id);
const [sA, sB] = [await makeStudent("A"), await makeStudent("B")];
await db.enrolment.create({ data: { unitId: unit.id, studentId: sA.id } });
await db.enrolment.create({ data: { unitId: unit.id, studentId: sB.id } });
// An ungrouped unit's roster is its enrolment list, so this session's live view
// carries exactly sA and sB — what the conductPoints assertion needs.
const session = await db.hndSession.create({ data: { unitId: unit.id, date: "2026-01-06", startTime: "09:00", endTime: "10:00" } });
made.sessions.push(session.id);

const studentLogin = await call("/auth/login", { method: "POST", body: { email: sA.email, password: "StudentPass123!" } });

try {
  /* ----------------------------- the vocabulary ---------------------------- */

  await check("the platform vocabulary arrives complete, and notifies nobody by default", async () => {
    assert.equal(probe.status, 200);
    const v = probe.body.vocabulary || [];
    assert.ok(v.length >= 5, `only ${v.length} entries`);
    assert.ok(v.every((e) => e.notifyStudent === false), "a default entry notifies the student");
    assert.ok(v.some((e) => e.key === "merit"));
    return `${v.length} entries`;
  });

  await check("editing the vocabulary is the settings door — a plain staff member is refused", async () => {
    const r = await call("/conduct/vocabulary", { method: "PUT", token: tutor.token, body: { vocabulary: probe.body.vocabulary } });
    assert.equal(r.status, 403, `HTTP ${r.status}`);
  });

  /* ----------------------------- who may log ------------------------------- */

  await check("a member of staff who teaches nobody is refused, and an unknown student answers the SAME refusal", async () => {
    const real = await call("/conduct/events", { method: "POST", token: stranger.token, body: { studentId: sA.id, key: "merit" } });
    const fake = await call("/conduct/events", { method: "POST", token: stranger.token, body: { studentId: "no-such-student", key: "merit" } });
    assert.equal(real.status, 403, `real student: HTTP ${real.status}`);
    assert.equal(fake.status, 403, `unknown student: HTTP ${fake.status}`);
    assert.equal(real.body.error, fake.body.error, "the two refusals must be indistinguishable");
  });

  await check("a student token cannot log conduct", async () => {
    assert.ok(studentLogin.body?.token, `student fixture could not sign in: ${JSON.stringify(studentLogin.body).slice(0, 120)}`);
    const r = await call("/conduct/events", { method: "POST", token: studentLogin.body.token, body: { studentId: sB.id, key: "merit" } });
    assert.equal(r.status, 403, `HTTP ${r.status}`);
  });

  await check("an unknown vocabulary key is refused before any identity is consulted", async () => {
    const r = await call("/conduct/events", { method: "POST", token: tutor.token, body: { studentId: sA.id, key: "no-such-entry" } });
    assert.equal(r.status, 400, `HTTP ${r.status}`);
  });

  /* ----------------------------- logging and freezing ---------------------- */

  let eventId = null;
  await check("the tutor logs a merit against their own student", async () => {
    const r = await call("/conduct/events", { method: "POST", token: tutor.token, body: { studentId: sA.id, key: "merit", note: "great question in class", sessionId: session.id } });
    assert.equal(r.status, 201, `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`);
    assert.equal(r.body.label, "Merit");
    assert.equal(r.body.points, 1);
    eventId = r.body.id;
  });

  await check("a default entry notifies NOBODY — no Notification row exists for it", async () => {
    const n = await db.notification.findFirst({ where: { studentId: sA.id } });
    assert.equal(n, null, `a notification appeared: ${JSON.stringify(n).slice(0, 120)}`);
  });

  await check("relabelling the entry rewrites nothing already logged — history is frozen", async () => {
    const relabelled = probe.body.vocabulary.map((e) => (e.key === "merit" ? { ...e, label: "House point" } : e));
    const put = await call("/conduct/vocabulary", { method: "PUT", token: adminToken, body: { vocabulary: relabelled } });
    assert.equal(put.status, 200, `HTTP ${put.status}: ${JSON.stringify(put.body).slice(0, 120)}`);
    const row = await db.conductEvent.findUnique({ where: { id: eventId } });
    assert.equal(row.label, "Merit", `the logged event now reads "${row.label}"`);
    // New events pick up the new words — the freeze is per event, not per key.
    const fresh = await call("/conduct/events", { method: "POST", token: tutor.token, body: { studentId: sA.id, key: "merit" } });
    assert.equal(fresh.body.label, "House point", `a new event reads "${fresh.body.label}"`);
  });

  await check("the student is told exactly when the college switches that entry on", async () => {
    const withNotify = probe.body.vocabulary.map((e) => (e.key === "merit" ? { ...e, notifyStudent: true } : e));
    const put = await call("/conduct/vocabulary", { method: "PUT", token: adminToken, body: { vocabulary: withNotify } });
    assert.equal(put.status, 200);
    const r = await call("/conduct/events", { method: "POST", token: tutor.token, body: { studentId: sB.id, key: "merit" } });
    assert.equal(r.status, 201);
    // notifyStudent runs after the response; poll briefly rather than sleeping once.
    let n = null;
    for (let i = 0; i < 25 && !n; i++) { n = await db.notification.findFirst({ where: { studentId: sB.id } }); if (!n) await new Promise((res) => setTimeout(res, 120)); }
    assert.ok(n, "no notification arrived for a notify-on entry");
    assert.equal(n.link, "inbox");
  });

  /* ----------------------------- reading back ------------------------------ */

  await check("a student's history is an exact key set, and a stranger cannot read it", async () => {
    const mine = await call(`/conduct/events?studentId=${sA.id}`, { token: tutor.token });
    assert.equal(mine.status, 200);
    assert.ok((mine.body.events || []).length >= 2);
    assert.deepEqual(Object.keys(mine.body.events[0]).sort(),
      ["createdAt", "id", "key", "label", "note", "points", "staffName", "tone"]);
    const theirs = await call(`/conduct/events?studentId=${sA.id}`, { token: stranger.token });
    assert.equal(theirs.status, 403, `stranger read: HTTP ${theirs.status}`);
  });

  await check("the live register distinguishes 'no events ever' (null) from a real net figure", async () => {
    const live = await call(`/hnd/sessions/${session.id}/live`, { token: tutor.token });
    assert.equal(live.status, 200, `HTTP ${live.status}`);
    const rowA = live.body.rows.find((r) => r.student.id === sA.id);
    const rowB = live.body.rows.find((r) => r.student.id === sB.id);
    assert.equal(rowA.conductPoints, 2, `sA net=${rowA.conductPoints}`); // two merits at +1
    assert.equal(rowB.conductPoints, 1, `sB net=${rowB.conductPoints}`);
    // sB has one event; the null case needs a student with none — un-enrol nobody,
    // just assert against a fresh student added to the unit with no events.
    const sC = await makeStudent("C");
    await db.enrolment.create({ data: { unitId: unit.id, studentId: sC.id } });
    const again = await call(`/hnd/sessions/${session.id}/live`, { token: tutor.token });
    const rowC = again.body.rows.find((r) => r.student.id === sC.id);
    assert.notEqual(rowC, undefined, "the fresh student is missing from the roster");
    assert.equal(rowC.conductPoints, null, `no-events student reads ${rowC.conductPoints}, not null`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
} catch (e) {
  console.error("suite error:", e);
  process.exitCode = 1;
} finally {
  // The vocabulary back to the platform defaults — this suite customised it twice.
  await call("/conduct/vocabulary", { method: "PUT", token: adminToken, body: { vocabulary: null } });
  await db.conductEvent.deleteMany({ where: { studentId: { in: made.students } } });
  await db.notification.deleteMany({ where: { studentId: { in: made.students } } });
  await db.hndSession.deleteMany({ where: { id: { in: made.sessions } } });
  await db.unit.deleteMany({ where: { id: { in: made.units } } });
  await db.student.deleteMany({ where: { id: { in: made.students } } });
  await db.staff.deleteMany({ where: { id: { in: made.staff } } });
  await db.$disconnect();
}
