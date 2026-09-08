// HND registers — the attendance record the college has to be able to evidence.
//
// Attendance is the most-audited number this product holds: UKVI asks for it, the
// funding body asks for it, and a student disputing an absence asks for it. Every
// assertion below guards a thing that, if it broke, would either put a mark on the
// wrong person's record, let the wrong person read or edit a register, or quietly
// move a percentage somebody has already reported to a regulator.
//
// So this suite is mostly NEGATIVE. It builds its own course, cohort, terms, units
// and students, tries the things that must not work, and removes everything it made —
// the seeded HND fixtures are shared with the other suites in the run and are only
// read here, never mutated.
//
//   npm test -- smoke-hnd
//   (needs API_URL + DATABASE_URL; the runner supplies both)
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

// API_URL is what scripts/test.mjs actually exports to a suite. Reading anything else
// (as smoke-branding once did) means silently talking to a port nobody is listening on.
const BASE = process.env.API_URL || "http://localhost:4000/api";
const ADMIN = process.env.SEED_ADMIN_EMAIL || "admin@edtech.co.uk";
const PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — point it at a throwaway database.");
  process.exit(1);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const bcrypt = require(join(server, "node_modules", "bcryptjs"));
// A BARE client. Used only to mint the two fixtures the HTTP API
// deliberately refuses to mint for us — a page-scoped admin account and a student
// password — to verify that a refused write really wrote nothing, and to sweep up.
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

let passed = 0, failed = 0;
const ok = (label, detail) => { passed++; console.log(`✓ ${label}${detail ? "  — " + detail : ""}`); };
const bad = (label, e) => { failed++; console.log(`✗ ${label}\n    ${e && e.message ? e.message : e}`); };
async function check(label, fn) {
  try { const d = await fn(); ok(label, d); } catch (e) { bad(label, e); }
}

const call = async (path, { method = "GET", body, token } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
};

// Distinct per run so a crashed run cannot poison the next one's uniqueness checks.
const RUN = Date.now().toString(36);
const NARROW_PW = "narrow-admin-password-2026";
const STUDENT_PW = "student-app-password-2026";

console.log("\n=== HND registers ===\n");

const login = await call("/auth/login", { method: "POST", body: { email: ADMIN, password: PASSWORD } });
if (!login.body?.token) {
  console.log("✗ could not sign in as the seeded admin — is the API seeded?");
  console.log(JSON.stringify(login.body).slice(0, 300));
  process.exit(1);
}
const admin = login.body.token;

// Everything this suite creates, so the finally block can remove it whatever happens.
const made = { staff: [], students: [], units: [], courses: [], semesters: [] };

async function cleanup() {
  // Deleting the course cascades to its cohort and terms; deleting a unit cascades to
  // its sessions, marks and enrolments. Ids only — never a blanket deleteMany, because
  // seven other suites share this database in the same run.
  const sweep = async (what, fn) => { try { await fn(); } catch (e) { console.log(`  cleanup ${what}: ${e.message}`); } };
  await sweep("staff", () => db.staff.deleteMany({ where: { id: { in: made.staff } } }));
  await sweep("students", () => db.student.deleteMany({ where: { id: { in: made.students } } }));
  await sweep("units", () => db.unit.deleteMany({ where: { id: { in: made.units } } }));
  await sweep("courses", () => db.course.deleteMany({ where: { id: { in: made.courses } } }));
  await sweep("semesters", () => db.semester.deleteMany({ where: { id: { in: made.semesters } } }));
}

try {
  /* ================================ fixtures ================================ */

  const course = await call("/hnd/courses", { method: "POST", token: admin, body: { name: `Smoke HND ${RUN}` } });
  assert.equal(course.status, 201, `course create: ${course.status} ${JSON.stringify(course.body)}`);
  made.courses.push(course.body.id);

  // A cohort whose terms all sit firmly in the PAST — that is the fixture the register
  // lock needs, and it must not depend on what today's date happens to be.
  const cohort = await call("/hnd/cohorts", { method: "POST", token: admin, body: { name: `SEP ${RUN}`, courseId: course.body.id, startDate: "2020-01-06" } });
  assert.equal(cohort.status, 201, `cohort create: ${cohort.status} ${JSON.stringify(cohort.body)}`);

  // U1 belongs to no term: the unlocked unit, where validation and percentages are tested.
  const u1 = await call("/hnd/units", { method: "POST", token: admin, body: { code: `SMK1${RUN}`, name: "Smoke Unit One", courseId: course.body.id } });
  assert.equal(u1.status, 201, `unit create: ${u1.status} ${JSON.stringify(u1.body)}`);
  made.units.push(u1.body.id);
  // U2 gets pinned to a closed term: the locked unit.
  const u2 = await call("/hnd/units", { method: "POST", token: admin, body: { code: `SMK2${RUN}`, name: "Smoke Unit Two", courseId: course.body.id } });
  assert.equal(u2.status, 201, `unit create: ${u2.status} ${JSON.stringify(u2.body)}`);
  made.units.push(u2.body.id);

  const students = [];
  for (const [i, first] of ["Ada", "Bram", "Cleo"].entries()) {
    const r = await call("/hnd/students", {
      method: "POST", token: admin,
      body: { firstName: first, lastName: `Smoke${RUN}`, studentRef: `SMK-${RUN}-${i}`, email: `smk-${RUN}-${i}@smoke.test`, unitIds: [u1.body.id, u2.body.id] },
    });
    assert.equal(r.status, 201, `student create: ${r.status} ${JSON.stringify(r.body)}`);
    made.students.push(r.body.id);
    students.push(r.body);
  }
  const [ada, bram, cleo] = students;

  // Page-scoped admins. The HTTP API cannot create these — adminPages is written only
  // by the Super-Admin route, which no seeded account can reach — so they are minted
  // directly. The alternative is not testing the permission grid at all.
  async function narrowAdmin(key, pages) {
    const row = await db.staff.create({ data: {
      name: `Narrow ${key} ${RUN}`, jobTitle: "Administrator", dept: "Administration",
      email: `narrow-${key}-${RUN}@smoke.test`, passwordHash: bcrypt.hashSync(NARROW_PW, 10),
      accountRole: "ADMIN", adminPages: JSON.stringify(pages), initials: "NA", colour: "#334155",
    }});
    made.staff.push(row.id);
    const r = await call("/auth/login", { method: "POST", body: { email: row.email, password: NARROW_PW } });
    assert.ok(r.body?.token, `narrow admin ${key} could not sign in: ${JSON.stringify(r.body)}`);
    return r.body.token;
  }
  const execToken = await narrowAdmin("exec", ["executive"]);
  const registersToken = await narrowAdmin("registers", ["registers"]);
  const studentsToken = await narrowAdmin("students", ["students"]);

  // A student who can actually sign in. No seeded student has a password, and the real
  // sign-up flow needs an approval round-trip that belongs to another suite.
  await db.student.update({ where: { id: ada.id }, data: { passwordHash: bcrypt.hashSync(STUDENT_PW, 10) } });
  const studentLogin = await call("/auth/login", { method: "POST", body: { email: ada.email, password: STUDENT_PW } });
  assert.ok(studentLogin.body?.token, `student could not sign in: ${JSON.stringify(studentLogin.body)}`);
  const studentToken = studentLogin.body.token;

  /* ---------------------------------------------------------- who gets in --- */
  console.log("--- adding a student and putting them on their units ---");

  await check("a new student is enrolled in the same call that creates them", async () => {
    // This 500'd. The route nests `enrolments: { create: [...] }` inside the student
    // create, and the old tenant extension stamped tenantId onto the model it was called
    // on and never onto child rows, so Prisma rejected the whole insert. Adding a student
    // to their units is THE way a student is added, so the normal path was dead while the
    // fiddly two-step one (create, then PUT enrolments) worked.
    //
    // THE ROUTE NO LONGER NESTS, AND THAT IS NOW THE INTENDED SHAPE — this comment
    // said the opposite for a while, which would have sent someone "fixing" it back.
    // routes/hnd.js creates the enrolments as their own top-level createMany, and
    // earns that shape twice over independently of tenancy: createMany takes
    // skipDuplicates, so re-submitting the same unit list is not a 500 on a unique
    // violation, and the unit ids are validated in one count up front, so a bad id is
    // a 400 rather than a mid-write foreign key error.
    //
    // The assertion is KEPT regardless, because what it actually checks is that
    // adding a student to their units in one call works at all — that is THE way a
    // student is added, and it was dead once. It passes whichever shape the route
    // uses, so it does not police the refactor; the comment above does.
    //
    // What has gone is the third assertion, that every child row carried the creating
    // institution's tenantId — there is one institution and no such column.
    assert.equal(ada.unitIds?.length, 2, `expected 2 unitIds back, got ${JSON.stringify(ada.unitIds)}`);
    const rows = await db.enrolment.findMany({ where: { studentId: ada.id } });
    assert.equal(rows.length, 2, `expected 2 enrolment rows, found ${rows.length}`);
    return "2 enrolments written by the nested create";
  });

  console.log("\n--- who can reach the registers at all ---");

  await check("an unauthenticated caller cannot read the register system", async () => {
    const r = await call("/hnd/units");
    assert.equal(r.status, 401, `expected 401, got ${r.status}`);
    return "no token, no attendance data";
  });

  await check("a plain STAFF account is refused every HND route", async () => {
    const staff = await call("/auth/login", { method: "POST", body: { email: "j.whitfield@edtech.co.uk", password: PASSWORD } });
    assert.ok(staff.body?.token, "seeded staff login failed");
    // The whole student directory and attendance matrix sit behind this router-level
    // guard. A lecturer with an ordinary account must not be able to pull the roster.
    const r = await call("/hnd/students", { token: staff.body.token });
    assert.equal(r.status, 403, `expected 403, got ${r.status}`);
    return r.body.error;
  });

  await check("a STUDENT token cannot reach a staff router", async () => {
    // requireAuth's router allowlist, not any guard in hnd.js. If this ever passes, one
    // student can read every other student's attendance and contact details.
    const r = await call("/hnd/students", { token: studentToken });
    assert.equal(r.status, 403, `expected 403, got ${r.status}`);
    assert.match(r.body.error || "", /student accounts/i);
    return r.body.error;
  });

  await check("an admin granted only Executive can read but not write", async () => {
    // The Executive Dashboard reads courses, units and attendance from here, so read
    // access is deliberate. A read-only dashboard grant that also hands out the ability
    // to create and delete units is exactly the escalation the two-tier guard stops.
    const read = await call("/hnd/units", { token: execToken });
    assert.equal(read.status, 200, `read expected 200, got ${read.status}`);
    const write = await call("/hnd/units", { method: "POST", token: execToken, body: { code: `EXEC${RUN}`, name: "Should not exist" } });
    assert.equal(write.status, 403, `write expected 403, got ${write.status}`);
    const leaked = await db.unit.count({ where: { code: `EXEC${RUN}` } });
    assert.equal(leaked, 0, "the refused unit was created anyway");
    return "read 200 / write 403";
  });

  await check("Registers and Students are two separate authorities", async () => {
    // Two checkboxes in the Access grid must not collapse into one server-side
    // authority: a Registers admin deleting a student cascades away their grades and
    // PAT records, and a Students admin deleting a unit takes every register with it.
    const regKillsStudent = await call(`/hnd/students/${cleo.id}`, { method: "DELETE", token: registersToken });
    assert.equal(regKillsStudent.status, 403, `registers-admin delete student expected 403, got ${regKillsStudent.status}`);
    const stuKillsUnit = await call(`/hnd/units/${u1.body.id}`, { method: "DELETE", token: studentsToken });
    assert.equal(stuKillsUnit.status, 403, `students-admin delete unit expected 403, got ${stuKillsUnit.status}`);
    assert.ok(await db.student.findUnique({ where: { id: cleo.id } }), "the student was deleted despite the 403");
    assert.ok(await db.unit.findUnique({ where: { id: u1.body.id } }), "the unit was deleted despite the 403");
    return "403 both ways, and nothing was removed";
  });

  await check("enrolment stays editable from either side of the grid", async () => {
    // Enrolments genuinely belong to both screens — a Students admin maintaining the
    // directory has to be able to put someone on a unit. Proving the shared route is
    // OPEN matters as much as proving the narrow ones are shut, or the grid is unusable.
    const r = await call(`/hnd/students/${cleo.id}/enrolments`, { method: "PUT", token: studentsToken, body: { unitIds: [u1.body.id, u2.body.id] } });
    assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    return "students-admin may set enrolments";
  });

  /* ------------------------------------------------------ what a date is --- */
  console.log("\n--- a register has to be filed on a day that exists ---");

  await check("an impossible calendar date is rejected", async () => {
    // V8 rolls "2039-02-30" forward to 2 March rather than returning Invalid Date, so
    // a shape-only check accepts it. A session filed on a non-existent day falls outside
    // every semester and term range and can never be found or corrected again.
    const r = await call("/hnd/sessions", { method: "POST", token: admin, body: { unitId: u1.body.id, date: "2039-02-30", start: "09:00", end: "12:00" } });
    assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
    const stray = await db.hndSession.findFirst({ where: { unitId: u1.body.id, date: { in: ["2039-02-30", "2039-03-02"] } } });
    assert.equal(stray, null, "a session was created on the rolled-over date");
    return r.body.error;
  });

  await check("an impossible clock time is rejected", async () => {
    const r = await call("/hnd/sessions", { method: "POST", token: admin, body: { unitId: u1.body.id, date: "2031-03-03", start: "25:00", end: "26:00" } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    return r.body.error;
  });

  await check("a register cannot end before it starts", async () => {
    // A negative-length session makes "taught hours" nonsense, and taught hours are
    // what funding is claimed against.
    const r = await call("/hnd/sessions", { method: "POST", token: admin, body: { unitId: u1.body.id, date: "2031-03-03", start: "13:00", end: "10:00" } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    return r.body.error;
  });

  const s1 = await call("/hnd/sessions", { method: "POST", token: admin, body: { unitId: u1.body.id, date: "2031-03-03", start: "10:00", end: "13:00", description: "Smoke" } });
  assert.equal(s1.status, 201, `session create: ${s1.status} ${JSON.stringify(s1.body)}`);

  await check("one unit cannot hold two registers at the same date and time", async () => {
    // @@unique([unitId, date, startTime]). Two registers for one taught class means two
    // sets of marks, and a percentage that depends on which one a report happens to read.
    const dup = await call("/hnd/sessions", { method: "POST", token: admin, body: { unitId: u1.body.id, date: "2031-03-03", start: "10:00", end: "13:00" } });
    assert.equal(dup.status, 409, `expected 409, got ${dup.status} ${JSON.stringify(dup.body)}`);
    const n = await db.hndSession.count({ where: { unitId: u1.body.id, date: "2031-03-03", startTime: "10:00" } });
    assert.equal(n, 1, `expected exactly one register, found ${n}`);
    return dup.body.error;
  });

  await check("generating a term's registers twice creates nothing the second time", async () => {
    // Admins re-run "create the registers" after editing a unit's dates all the time.
    // Without idempotency every re-run duplicates the whole schedule, and every
    // duplicate is an untaken register dragging the class percentage down.
    const body = { start: "2031-06-02", end: "2031-06-16", startTime: "08:00", endTime: "09:00" };
    const first = await call(`/hnd/units/${u1.body.id}/sessions/generate`, { method: "POST", token: admin, body });
    assert.equal(first.status, 201, `expected 201, got ${first.status} ${JSON.stringify(first.body)}`);
    assert.equal(first.body.weeks, 3, `expected 3 weekly registers, got ${first.body.weeks}`);
    assert.equal(first.body.created, 3, `expected 3 created, got ${first.body.created}`);
    const second = await call(`/hnd/units/${u1.body.id}/sessions/generate`, { method: "POST", token: admin, body });
    assert.equal(second.body.created, 0, `re-run created ${second.body.created} duplicate register(s)`);
    return "3 created, then 0";
  });

  /* --------------------------------------------------- marking a register --- */
  console.log("\n--- what may be written onto a register ---");

  await check("a status outside P/L/E/A is rejected", async () => {
    // Every percentage in the product is computed from those four letters. An
    // unrecognised status is silently worth nothing and drags the figure down.
    const r = await call(`/hnd/sessions/${s1.body.id}/register`, { method: "PUT", token: admin, body: { marks: [{ studentId: ada.id, status: "X" }] } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    return r.body.error;
  });

  await check("the same student cannot appear twice in one save", async () => {
    // Two rows for one person in one transaction is two writes to the same key: the
    // last one silently wins, so the register ends up showing a mark nobody chose.
    const r = await call(`/hnd/sessions/${s1.body.id}/register`, { method: "PUT", token: admin, body: { marks: [{ studentId: ada.id, status: "P" }, { studentId: ada.id, status: "A" }] } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    return r.body.error;
  });

  await check("a save larger than a class is refused", async () => {
    // No register can legitimately hold more rows than the unit has students. Without
    // the cap, one 1MB request becomes thousands of operations in a single transaction
    // and holds a connection long enough to starve the whole API.
    const marks = Array.from({ length: 501 }, (_, i) => ({ studentId: `bulk-${i}`, status: "P" }));
    const r = await call(`/hnd/sessions/${s1.body.id}/register`, { method: "PUT", token: admin, body: { marks } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    assert.match(r.body.error || "", /limit 500/);
    return r.body.error;
  });

  await check("a student who is not on the unit cannot be marked", async () => {
    // Existence is not enrolment. A mistyped or stale id attaching a mark — and with it
    // a whole unit's attendance record — to somebody who was never on the course is how
    // one student's absence ends up on another's compliance report.
    const outsider = await call("/hnd/students", {
      method: "POST", token: admin,
      body: { firstName: "Dara", lastName: `Outsider${RUN}`, studentRef: `SMK-${RUN}-out`, email: `smk-${RUN}-out@smoke.test` },
    });
    assert.equal(outsider.status, 201, `outsider create: ${outsider.status} ${JSON.stringify(outsider.body)}`);
    made.students.push(outsider.body.id);
    const r = await call(`/hnd/sessions/${s1.body.id}/register`, { method: "PUT", token: admin, body: { marks: [{ studentId: outsider.body.id, status: "P" }] } });
    assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
    // Wording changed with the roster fix: a student can now reach a register through
    // their GROUP as well as through an enrolment, so "not enrolled on this unit" was
    // no longer the reason. The assertion that matters is unchanged -- an outsider,
    // in neither, is refused and told which register they are not on.
    assert.match(r.body.error || "", /not on this register/i);
    const leaked = await db.attendanceMark.count({ where: { studentId: outsider.body.id } });
    assert.equal(leaked, 0, `${leaked} mark(s) were written for a non-enrolled student`);
    return r.body.error;
  });

  await check("a malformed enrolment payload does not wipe the student's units", async () => {
    // This is the one call that can clear a student's whole enrolment set. Reading a
    // string (or a missing field) as "remove them from everything" drops somebody off
    // every register — and returns a cheerful 200 while doing it.
    const r = await call(`/hnd/students/${bram.id}/enrolments`, { method: "PUT", token: admin, body: { unitIds: "all" } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    const still = await db.enrolment.count({ where: { studentId: bram.id } });
    assert.equal(still, 2, `expected 2 enrolments intact, found ${still}`);
    return `${r.body.error} — 2 enrolments intact`;
  });

  /* --------------------------------------------------------- the numbers --- */
  console.log("\n--- the percentage the college reports ---");

  await check("attendance is scored P=2, L=1, E=1, A=0", async () => {
    const save = await call(`/hnd/sessions/${s1.body.id}/register`, {
      method: "PUT", token: admin,
      body: { marks: [{ studentId: ada.id, status: "P" }, { studentId: bram.id, status: "L" }, { studentId: cleo.id, status: "E" }] },
    });
    assert.equal(save.status, 200, `expected 200, got ${save.status} ${JSON.stringify(save.body)}`);
    assert.equal(save.body.saved, 3, `expected 3 marks saved, got ${save.body.saved}`);
    // (2 + 1 + 1) / (3 × 2) = 66.7%. If this weighting ever drifts, every attendance
    // figure the college has already reported drifts with it.
    const m = await call(`/hnd/attendance/monthly?unitId=${u1.body.id}`, { token: admin });
    assert.equal(m.body.totals.pct, 66.7, `expected 66.7, got ${m.body.totals.pct}`);
    assert.equal(m.body.totals.marked, 3, `expected 3 marked, got ${m.body.totals.marked}`);
    return "66.7% from P+L+E";
  });

  await check("registers nobody has taken do not count against anyone", async () => {
    // U1 now has four registers: one marked, three generated and still blank. An untaken
    // register must be excluded, not scored as absence — otherwise a class's figure
    // collapses the moment next term's registers are generated.
    const sessions = await call(`/hnd/sessions?unitId=${u1.body.id}`, { token: admin });
    const blank = sessions.body.filter((s) => s.markedCount === 0).length;
    assert.equal(blank, 3, `expected 3 untaken registers, found ${blank}`);
    const m = await call(`/hnd/attendance/monthly?unitId=${u1.body.id}`, { token: admin });
    assert.equal(m.body.totals.pct, 66.7, `untaken registers moved the percentage to ${m.body.totals.pct}`);
    assert.equal(m.body.sessions, 4, `expected 4 sessions in scope, got ${m.body.sessions}`);
    return "3 blank registers, percentage unchanged";
  });

  await check("saving the same register twice changes nothing", async () => {
    // The UI re-sends the whole class on every save. Upsert, not insert: a second save
    // must not double a student's marks and halve their percentage.
    const again = await call(`/hnd/sessions/${s1.body.id}/register`, {
      method: "PUT", token: admin,
      body: { marks: [{ studentId: ada.id, status: "P" }, { studentId: bram.id, status: "L" }, { studentId: cleo.id, status: "E" }] },
    });
    assert.equal(again.body.saved, 3, `expected 3, got ${again.body.saved}`);
    const rows = await db.attendanceMark.count({ where: { sessionId: s1.body.id } });
    assert.equal(rows, 3, `expected 3 mark rows, found ${rows}`);
    const m = await call(`/hnd/attendance/monthly?unitId=${u1.body.id}`, { token: admin });
    assert.equal(m.body.totals.pct, 66.7, `the re-save moved the percentage to ${m.body.totals.pct}`);
    return "idempotent";
  });

  await check("un-enrolling a student keeps the register they were on", async () => {
    // Past registers must read as they were taken. Dropping the marks when somebody
    // leaves a unit rewrites history — and it is always the leaver whose attendance is
    // the thing being questioned.
    const r = await call(`/hnd/students/${cleo.id}/enrolments`, { method: "PUT", token: admin, body: { unitIds: [u2.body.id] } });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    const reg = await call(`/hnd/sessions/${s1.body.id}/register`, { token: admin });
    const row = reg.body.rows.find((x) => x.student.id === cleo.id);
    assert.ok(row, "the un-enrolled student vanished from the register they were marked on");
    assert.equal(row.status, "E", `their mark changed to ${row.status}`);
    assert.equal(row.enrolled, false, "they are still shown as enrolled");
    return "mark kept, flagged as no longer enrolled";
  });

  /* ---------------------------------------------------- closing the term --- */
  console.log("\n--- a closed term is a closed record ---");

  const gen = await call(`/hnd/cohorts/${cohort.body.id}/terms/generate`, { method: "POST", token: admin, body: {} });
  assert.equal(gen.status, 201, `term generate: ${gen.status} ${JSON.stringify(gen.body)}`);
  const closedTerm = gen.body[0];

  await check("a cohort's terms are generated once, not twice", async () => {
    // Re-generating would either duplicate the calendar or renumber it underneath the
    // registers already locked to it.
    assert.equal(gen.body.length, 6, `expected 6 terms, got ${gen.body.length}`);
    const twice = await call(`/hnd/cohorts/${cohort.body.id}/terms/generate`, { method: "POST", token: admin, body: {} });
    assert.equal(twice.status, 409, `expected 409, got ${twice.status}`);
    return `6 terms, second attempt ${twice.status}`;
  });

  await check("two terms in one cohort cannot claim the same day", async () => {
    // Terms drive register locking. Two "current" terms means which register opens is
    // arbitrary, and a whole cohort's attendance becomes uneditable at random.
    const second = gen.body[1];
    const r = await call(`/hnd/terms/${second.id}`, { method: "PUT", token: admin, body: { start: closedTerm.start, end: closedTerm.end } });
    assert.equal(r.status, 409, `expected 409, got ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.error;
  });

  const pin = await call(`/hnd/units/${u2.body.id}`, { method: "PUT", token: admin, body: { cohortId: cohort.body.id, termId: closedTerm.id } });
  assert.equal(pin.status, 200, `unit pin: ${pin.status} ${JSON.stringify(pin.body)}`);
  const s2 = await call("/hnd/sessions", { method: "POST", token: admin, body: { unitId: u2.body.id, date: "2020-02-03", start: "10:00", end: "13:00" } });
  assert.equal(s2.status, 201, `locked-unit session: ${s2.status} ${JSON.stringify(s2.body)}`);

  await check("re-saving a unit's cohort does not silently unlink its term", async () => {
    // An OMITTED termId means "leave it alone". Reading it as "clear it" permanently
    // unlocked every register on that unit and returned 200 with nothing in the
    // response to say a term link had just been dropped.
    const r = await call(`/hnd/units/${u2.body.id}`, { method: "PUT", token: admin, body: { cohortId: cohort.body.id } });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    assert.equal(r.body.termId, closedTerm.id, `termId became ${r.body.termId}`);
    return "term link survived";
  });

  await check("a register in a closed term will not accept marks", async () => {
    const r = await call(`/hnd/sessions/${s2.body.id}/register`, { method: "PUT", token: admin, body: { marks: [{ studentId: ada.id, status: "P" }] } });
    assert.equal(r.status, 423, `expected 423, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.locked, true, "the response did not flag the register as locked");
    const written = await db.attendanceMark.count({ where: { sessionId: s2.body.id } });
    assert.equal(written, 0, "a mark was written to a locked register");
    return r.body.error;
  });

  await check("reopening it stamps the correction as out-of-term", async () => {
    // A mark added months after the term closed must not be indistinguishable from one
    // taken on the day — that is the first question an audit asks, and the reason the
    // override is allowed at all rather than being an outright refusal.
    const r = await call(`/hnd/sessions/${s2.body.id}/register`, { method: "PUT", token: admin, body: { override: true, marks: [{ studentId: ada.id, status: "P" }] } });
    assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const mark = await db.attendanceMark.findFirst({ where: { sessionId: s2.body.id, studentId: ada.id } });
    assert.match(mark?.takenBy || "", /out-of-term correction/, `takenBy was "${mark?.takenBy}"`);
    return mark.takenBy;
  });

  await check("a locked register cannot be deleted out from under its marks", async () => {
    // Editing a closed term's register is gated; DELETING one — which cascades away
    // every mark on it — has to be gated by the same rule, or the lock protects the
    // marks and not the register that holds them.
    const r = await call(`/hnd/sessions/${s2.body.id}`, { method: "DELETE", token: admin });
    assert.equal(r.status, 423, `expected 423, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(await db.hndSession.findUnique({ where: { id: s2.body.id } }), "the locked register was deleted anyway");
    const survivors = await db.attendanceMark.count({ where: { sessionId: s2.body.id } });
    assert.equal(survivors, 1, `the marks went with it (${survivors} left)`);
    return r.body.error;
  });

  /* ------------------------------------------------------------ semesters --- */
  console.log("\n--- semesters cannot overlap ---");

  await check("overlapping semester ranges are refused, adjacent ones are not", async () => {
    // "Which semester is this session in?" must have exactly one answer. Two overlapping
    // ranges give a session two homes and the same attendance gets reported twice. The
    // second half matters as much: a rule that simply forbade adjacency would make a
    // normal academic year impossible to enter.
    const a = await call("/hnd/semesters", { method: "POST", token: admin, body: { name: `Smoke A ${RUN}`, start: "2087-01-01", end: "2087-06-30" } });
    assert.equal(a.status, 201, `first semester: ${a.status} ${JSON.stringify(a.body)}`);
    made.semesters.push(a.body.id);
    const clash = await call("/hnd/semesters", { method: "POST", token: admin, body: { name: `Smoke B ${RUN}`, start: "2087-06-30", end: "2087-12-31" } });
    assert.equal(clash.status, 400, `overlap expected 400, got ${clash.status} ${JSON.stringify(clash.body)}`);
    assert.match(clash.body.error || "", /overlap/i);
    const b = await call("/hnd/semesters", { method: "POST", token: admin, body: { name: `Smoke B ${RUN}`, start: "2087-07-01", end: "2087-12-31" } });
    assert.equal(b.status, 201, `adjacent semester: ${b.status} ${JSON.stringify(b.body)}`);
    made.semesters.push(b.body.id);
    return clash.body.error;
  });

  /* ------------------------------------------------- the seeded fixtures --- */
  console.log("\n--- the seeded college, read only ---");

  await check("the seeded untaken Workshop register still reads as untaken", async () => {
    // The seed leaves the most recent m-ws register deliberately blank, alongside two
    // future ones. It is the fixture that proves "taken" is derived from marks rather
    // than from the session existing, and other suites depend on it staying blank.
    const r = await call("/hnd/sessions?unitId=m-ws", { token: admin });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    assert.equal(r.body.length, 8, `expected 8 seeded Workshop sessions, got ${r.body.length}`);
    const untaken = r.body.filter((s) => s.markedCount === 0);
    assert.equal(untaken.length, 3, `expected 3 untaken, got ${untaken.length}`);
    return "5 taken, 3 untaken";
  });

  await check("the attendance matrix is stable between two identical reads", async () => {
    // The matrix is rebuilt from raw SQL on every call. Two identical requests returning
    // two different overall percentages would mean the executive dashboard and the
    // compliance report disagree depending on who refreshed last.
    const a = await call("/hnd/attendance", { token: admin });
    const b = await call("/hnd/attendance", { token: admin });
    assert.equal(a.status, 200, `expected 200, got ${a.status}`);
    assert.equal(a.body.overall.pct, b.body.overall.pct, `${a.body.overall.pct} then ${b.body.overall.pct}`);
    assert.ok(a.body.overall.marked >= 194, `expected at least the 194 seeded marks, got ${a.body.overall.marked}`);
    return `overall ${a.body.overall.pct}% over ${a.body.overall.marked} marks`;
  });

  await check("an unknown scope is a 404, not a silent fall back to everything", async () => {
    // Falling back to "all sessions" on a bad scope shows the whole year's figures under
    // one term's heading, which is worse than an error because nobody notices.
    const r = await call(`/hnd/attendance?semesterId=no-such-semester-${RUN}`, { token: admin });
    assert.equal(r.status, 404, `expected 404, got ${r.status}`);
    return r.body.error;
  });
} catch (e) {
  bad("suite setup", e);
} finally {
  await cleanup();
  await db.$disconnect();
  console.log("\ncleanup: smoke course, units, students, semesters and accounts removed");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
