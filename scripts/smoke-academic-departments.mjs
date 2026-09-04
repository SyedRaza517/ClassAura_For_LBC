// The academic departments API — configuring them, and granting access to them.
//
// THE GUARD ITSELF IS PROVED ELSEWHERE. smoke-academic-scope.mjs landed with the wiring
// it tests and covers the boundary: unscoped queries throwing, findUnique refusing to
// cross, an account narrowed to nothing seeing nothing, the raw SQL aggregates. None of
// that is repeated here — two suites failing for one bug means neither is the obvious
// place to look.
//
// What this covers is what that suite could not: the endpoints, which did not exist yet,
// and the denormalisation drift guard on Student.academicDepartmentId.
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

console.log("\n=== academic departments API ===\n");

const admin = await call("/auth/login", { method: "POST", body: { email: ADMIN, password: PASSWORD } });
if (!admin.body.token) {
  console.log("✗ could not sign in as the seeded admin — is the API seeded?");
  process.exit(1);
}
const adminToken = admin.body.token;

const probe = await call("/academic-departments", { token: adminToken });
if (probe.status === 404) {
  console.log("SKIP — /api/academic-departments is not mounted in this build");
  await db.$disconnect();
  process.exit(2);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const stamp = Date.now();
const BIZ = `biz-${stamp}`, CMP = `cmp-${stamp}`;

// TWO ACCOUNTS. `boss` is a Super Admin, because PUT /staff/:id is Super-Admin-only and
// the seeded college has none. `plain` is an ordinary admin that exists only to be
// refused by that route — a suite that never tests the refusal is testing nothing about
// the gate.
const people = {
  boss:  { name: "Dept Super Admin", email: `ad.boss.${stamp}@edtech.co.uk`, pw: "BossPass123!", superAdmin: true },
  plain: { name: "Ordinary Settings Admin", email: `ad.plain.${stamp}@edtech.co.uk`, pw: "PlainPass123!", superAdmin: false },
};
for (const p of Object.values(people)) {
  const made = await call("/staff", { method: "POST", token: adminToken, body: { name: p.name, email: p.email, password: p.pw } });
  if (!made.body?.id) { console.log(`✗ could not create fixture ${p.email}`); process.exit(1); }
  p.id = made.body.id;
  await db.staff.update({
    where: { id: p.id },
    data: {
      accountRole: "ADMIN",
      // A Super Admin's grant is null — every page. The other gets settings only, which
      // is what these routes require.
      adminPages: p.superAdmin ? null : JSON.stringify(["settings"]),
      ...(p.superAdmin ? { isSuperAdmin: true } : {}),
      mustChangePassword: false,
    },
  });
  const login = await call("/auth/login", { method: "POST", body: { email: p.email, password: p.pw } });
  if (!login.body?.token) { console.log(`✗ could not sign in as ${p.email}`); process.exit(1); }
  p.token = login.body.token;
}
const { boss, plain } = people;

let createdCourseId = null, movedStudentId = null, originalCohortId = null;
let mappingCourseIds = [], mappingCohortId = null, mappingStudentId = null;
let handMadeCourseId = null, handMadeCohortId = null, handMadeStudentId = null;

try {
  /* ------------------------------------------------------------------------ */
  /* Saving the list                                                           */
  /* ------------------------------------------------------------------------ */

  await check("departments save and read back", async () => {
    const put = await call("/academic-departments", {
      method: "PUT", token: adminToken,
      body: { departments: [
        { key: BIZ, name: "Business", colour: "#112233" },
        { key: CMP, name: "Computing" },
      ] },
    });
    assert.equal(put.status, 200, `PUT gave ${put.status}`);
    const got = put.body.departments.filter((d) => d.key === BIZ || d.key === CMP);
    assert.equal(got.length, 2);
    assert.equal(got.find((d) => d.key === BIZ).colour, "#112233");
    // An omitted colour falls back to the platform default rather than empty.
    assert.equal(got.find((d) => d.key === CMP).colour, "#1a3a8f");
    return "2 departments";
  });

  // Breaks if: the serialiser grows a field. Asserting that `key` and `colour` are
  // PRESENT passes just as happily when a sixth field leaks; the whole point of an
  // allowlist is that a column added tomorrow does not reach the browser because
  // somebody forgot. Exact key set, or this assertion is decorative.
  await check("the serialiser ships EXACTLY the allowed keys and no others", async () => {
    const res = await call("/academic-departments", { token: adminToken });
    const row = res.body.departments.find((d) => d.key === BIZ);
    assert.deepEqual(
      Object.keys(row).sort(),
      ["active", "colour", "courseCount", "id", "key", "name", "studentCount"],
    );
    return Object.keys(row).length + " keys";
  });

  // A BAD COLOUR IS CLEANED; A BAD KEY REFUSES THE WHOLE SUBMISSION. The asymmetry is
  // deliberate. A colour has a safe fallback, so the row survives. A key does not: an
  // unusable key means that department is ABSENT from the saved list, and absence is how
  // this endpoint expresses "retire" -- so silently dropping it would retire a department
  // the administrator was trying to add.
  await check("a bad colour is cleaned and the save succeeds", async () => {
    const put = await call("/academic-departments", {
      method: "PUT", token: adminToken,
      body: { departments: [
        { key: BIZ, name: "Business", colour: "javascript:alert(1)" },
        { key: CMP, name: "Computing" },
      ] },
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.departments.find((d) => d.key === BIZ).colour, "#1a3a8f");
    return "colour reset to the platform default";
  });

  // Breaks if: cleanList's drop-invalid rule reaches the retire sweep. One unusable key
  // would then silently retire whichever department it was meant to be.
  await check("one unusable key refuses the whole submission rather than retiring a department", async () => {
    const put = await call("/academic-departments", {
      method: "PUT", token: adminToken,
      body: { departments: [
        { key: BIZ, name: "Business" },
        { key: CMP, name: "Computing" },
        { key: "NOT A KEY", name: "Rejected" },
      ] },
    });
    assert.equal(put.status, 400, `expected 400, got ${put.status}`);
    const list = await call("/academic-departments", { token: adminToken });
    assert.ok(list.body.departments.find((d) => d.key === BIZ)?.active, "a department was retired by a refused save");
    assert.ok(!list.body.departments.some((d) => d.name === "Rejected"), "an invalid key was stored");
    return "400, nothing changed";
  });

  await check("a non-array body is refused", async () => {
    const res = await call("/academic-departments", { method: "PUT", token: adminToken, body: { departments: "business" } });
    assert.equal(res.status, 400);
    return "400";
  });

  /* ------------------------------------------------------------------------ */
  /* Retire, never delete                                                      */
  /* ------------------------------------------------------------------------ */

  // Breaks if: a department dropped from the list is DELETED instead of retired. Deleting
  // sets academicDepartmentId to null on every course and student pointing at it, which
  // under scoping hides them from every member of staff who teaches them. The assertion
  // checks the COURSE still points at the department, not merely that the row survives.
  await check("a department left out of the list is retired, and keeps its courses", async () => {
    const list = await call("/academic-departments", { token: adminToken });
    const biz = list.body.departments.find((d) => d.key === BIZ);
    const course = await db.course.create({ data: { name: `Retire Test ${stamp}`, academicDepartmentId: biz.id } });
    createdCourseId = course.id;

    const put = await call("/academic-departments", {
      method: "PUT", token: adminToken,
      body: { departments: [{ key: CMP, name: "Computing" }] },
    });
    assert.equal(put.status, 200);
    const retired = put.body.departments.find((d) => d.key === BIZ);
    assert.ok(retired, "the department was DELETED, not retired");
    assert.equal(retired.active, false, "the department was not marked inactive");

    const still = await db.course.findUnique({ where: { id: course.id } });
    assert.equal(still.academicDepartmentId, biz.id, "retiring a department orphaned its course");
    return "inactive, course still attached";
  });

  await check("a retired department comes back active when re-added", async () => {
    const put = await call("/academic-departments", {
      method: "PUT", token: adminToken,
      body: { departments: [{ key: BIZ, name: "Business" }, { key: CMP, name: "Computing" }] },
    });
    assert.equal(put.body.departments.find((d) => d.key === BIZ).active, true);
    return "reactivated";
  });

  /* ------------------------------------------------------------------------ */
  /* The summary — both fail directions, made visible                          */
  /* ------------------------------------------------------------------------ */

  await check("the summary reports college-wide staff and unassigned rows", async () => {
    const res = await call("/academic-departments/summary", { token: adminToken });
    assert.equal(res.status, 200);
    for (const k of ["collegeWideStaff", "totalStaff", "unassignedCourses", "totalCourses", "unassignedStudents", "totalStudents", "departmentCount"]) {
      assert.equal(typeof res.body[k], "number", `${k} is missing or not a number`);
    }
    // The migration made every account college-wide and nothing narrows them here, so the
    // count must be the whole staff list. A summary that under-reported this would hide
    // exactly the fail-open it exists to surface.
    assert.equal(res.body.collegeWideStaff, res.body.totalStaff, "college-wide count does not match the staff list");
    assert.ok(res.body.unassignedStudents > 0, "the seeded students should be unassigned");
    return `${res.body.collegeWideStaff}/${res.body.totalStaff} college-wide, ${res.body.unassignedStudents} students unassigned`;
  });

  /* ------------------------------------------------------------------------ */
  /* Granting access — the Super Admin gate                                    */
  /* ------------------------------------------------------------------------ */

  // Breaks if: the Super Admin check is dropped. An ordinary settings admin holds the
  // page, so requirePage alone lets them through — the extra check is the only thing
  // between "may edit the department list" and "may hand somebody the whole college".
  await check("an ordinary settings admin is REFUSED the access route", async () => {
    const res = await call(`/academic-departments/staff/${plain.id}`, {
      method: "PUT", token: plain.token, body: { academicDepartmentIds: [], collegeWide: true },
    });
    assert.equal(res.status, 403, `expected 403, got ${res.status}`);
    return "403";
  });

  // NARROWING IS REFUSED, AND THAT IS THE POINT OF THIS ASSERTION.
  //
  // The guard rewrites the TOP-LEVEL query only; a Prisma extension cannot reach a nested
  // include. Measured on 4 Sep 2026 with a scope owning nothing: student.findMany() gave
  // 0 while hndSession.findMany({ include: { marks: true } }) gave 194 attendance marks.
  // So an account narrowed to one department is NOT confined, and an API that accepted the
  // request would make the product promise something it cannot keep. Spec 2 closes the
  // nested reads route by route; until then this is a 400.
  await check("narrowing an account is REFUSED while nested reads are unfiltered", async () => {
    const list = await call("/academic-departments", { token: adminToken });
    const biz = list.body.departments.find((d) => d.key === BIZ);
    const res = await call(`/academic-departments/staff/${plain.id}`, {
      method: "PUT", token: boss.token, body: { academicDepartmentIds: [biz.id], collegeWide: false },
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status} — ${JSON.stringify(res.body)}`);
    assert.match(res.body.error || "", /not switched on yet/i);
    const s = await db.staff.findUnique({ where: { id: plain.id } });
    assert.equal(s.collegeWide, true, "the account was narrowed anyway");
    return "400, still college-wide";
  });

  // The permitted half still works: memberships can be recorded while the account stays
  // college-wide, so a college can prepare its structure before spec 2 turns filtering on.
  await check("assigning departments while staying college-wide is allowed", async () => {
    const list = await call("/academic-departments", { token: adminToken });
    const biz = list.body.departments.find((d) => d.key === BIZ);
    const res = await call(`/academic-departments/staff/${plain.id}`, {
      method: "PUT", token: boss.token, body: { academicDepartmentIds: [biz.id], collegeWide: true },
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status} — ${JSON.stringify(res.body)}`);
    const rows = await db.staffAcademicDepartment.findMany({ where: { staffId: plain.id } });
    assert.deepEqual(rows.map((r) => r.academicDepartmentId), [biz.id]);
    return "1 department, still college-wide";
  });

  // Breaks if: the mapping PUT keeps only requirePage("settings"). An admin whose
  // adminPages is null holds that page by default, which made this a self-service
  // escalation -- remap another department's category to your own id, then read those
  // students through the filtered paths with the guard working as designed.
  await check("an ordinary settings admin is REFUSED the VLE mapping write", async () => {
    const res = await call("/vle-department-mapping", {
      method: "PUT", token: plain.token,
      body: { externalId: `cat-${stamp}`, academicDepartmentId: null },
    });
    assert.equal(res.status, 403, `expected 403, got ${res.status}`);
    return "403";
  });

  // Breaks if: an unknown id is silently dropped. The Access screen would then show a
  // grant that was never made, which is worse than an error somebody can act on.
  // Breaks if: GET /staff drops the academicDepartments include. sStaff emits the field
  // only when the relation is loaded, and the Access screen reads it from THAT list -- so
  // without the include every member of staff renders with no departments ticked, under a
  // warning saying they can see nothing. An administrator correcting that by pressing Save
  // sends an empty list and the handler destroys the real membership. The screen then
  // agrees with itself, which is why nothing would have reported it.
  await check("the staff LIST carries academicDepartmentIds, not just the auth lookup", async () => {
    const res = await call("/staff", { token: adminToken });
    const row = (res.body || []).find((p) => p.id === plain.id);
    assert.ok(row, "the fixture is missing from the staff list");
    assert.ok(Array.isArray(row.academicDepartmentIds),
      "the staff list does not carry academicDepartmentIds — the Access screen will show every account as scoped to nothing");
    assert.equal(row.academicDepartmentIds.length, 1, "the membership just granted is not reflected in the list");
    // college-wide, because narrowing is refused while nested reads are unfiltered — the
    // membership is recorded and the flag stays on.
    assert.equal(row.collegeWide, true);
    return "1 department, still college-wide";
  });

  await check("an unknown department id is refused, not silently dropped", async () => {
    const res = await call(`/academic-departments/staff/${plain.id}`, {
      method: "PUT", token: boss.token, body: { academicDepartmentIds: ["not-a-real-id"], collegeWide: false },
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    const rows = await db.staffAcademicDepartment.findMany({ where: { staffId: plain.id } });
    assert.equal(rows.length, 1, "the failed request changed the membership anyway");
    return "400, membership unchanged";
  });

  // A truthy non-boolean is REFUSED rather than coerced in either direction. Reading "yes"
  // as true would grant the college; reading it as false would revoke access silently.
  // Neither is a guess worth making about the flag that decides who sees every student.
  await check("a truthy non-boolean collegeWide is refused, not coerced", async () => {
    const res = await call(`/academic-departments/staff/${plain.id}`, {
      method: "PUT", token: boss.token, body: { academicDepartmentIds: [], collegeWide: "yes" },
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    return "400";
  });

  // Breaks if: collegeWide is read as `=== true` with no presence check. A client that
  // PATCHes only the department list would then silently strip college-wide access --
  // and combined with the self-lockout below, that is how a Super Admin blinds
  // themselves by accident rather than on purpose.
  await check("an omitted collegeWide is refused rather than read as false", async () => {
    const res = await call(`/academic-departments/staff/${plain.id}`, {
      method: "PUT", token: boss.token, body: { academicDepartmentIds: [] },
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    return "400";
  });

  // Breaks if: nothing stops an account removing its OWN college-wide access. The Super
  // Admin would match `{ in: [] }` on every scoped model -- every register, student list
  // and prediction empty -- and the screen that would explain it is the empty one. This
  // follows the precedent in routes/staff.js, which special-cases the Super Admin's own
  // row so the equivalent lockout cannot be typed.
  await check("a Super Admin cannot remove their OWN college-wide access", async () => {
    const res = await call(`/academic-departments/staff/${boss.id}`, {
      method: "PUT", token: boss.token, body: { academicDepartmentIds: [], collegeWide: false },
    });
    // 400 either way — today from the narrowing gate, and from the self-lockout check once
    // spec 2 lifts that gate. Both are the right answer; the assertion is that the Super
    // Admin is still college-wide afterwards.
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    const s2 = await db.staff.findUnique({ where: { id: boss.id } });
    assert.equal(s2.collegeWide, true, "the Super Admin locked themselves out");
    return "400, still college-wide";
  });

  // Breaks if: cleanList's drop-invalid rule composes with retire-by-omission. Every row
  // being invalid yields an EMPTY kept list, and `notIn: []` matches every row -- so one
  // malformed submission retires the college's entire organisation chart, with a 200.
  await check("a submission whose rows are all invalid is refused, not read as retire-everything", async () => {
    const res = await call("/academic-departments", {
      method: "PUT", token: adminToken,
      body: { departments: [{ name: "No key at all" }, { key: "BAD KEY", name: "x" }] },
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    const list = await call("/academic-departments", { token: adminToken });
    assert.ok(list.body.departments.find((d) => d.key === BIZ)?.active, "the whole chart was retired by a bad submission");
    return "400, chart intact";
  });

  await check("a staff member who does not exist gives 404", async () => {
    // collegeWide TRUE deliberately: a false value is refused by the narrowing gate before
    // the staff row is ever looked up, which would make this assert the wrong thing.
    const res = await call("/academic-departments/staff/nobody", {
      method: "PUT", token: boss.token, body: { academicDepartmentIds: [], collegeWide: true },
    });
    assert.equal(res.status, 404);
    return "404";
  });

  /* ------------------------------------------------------------------------ */
  /* The denormalisation drift guard                                           */
  /* ------------------------------------------------------------------------ */

  // Breaks if: changing a student's cohort does not rewrite Student.academicDepartmentId.
  // The column is denormalised from the cohort's course, so it is right on the day it is
  // written and wrong from the first reorganisation onward — and a wrong value here is a
  // student visible to the wrong department's staff.
  await check("moving a student to another department's cohort moves their department", async () => {
    const list = await call("/academic-departments", { token: adminToken });
    const biz = list.body.departments.find((d) => d.key === BIZ);
    const cmp = list.body.departments.find((d) => d.key === CMP);

    const bizCourse = await db.course.create({ data: { name: `Drift Biz ${stamp}`, academicDepartmentId: biz.id } });
    const cmpCourse = await db.course.create({ data: { name: `Drift Cmp ${stamp}`, academicDepartmentId: cmp.id } });
    const bizCohort = await db.cohort.create({ data: { name: `DriftB ${stamp}`, courseId: bizCourse.id } });
    const cmpCohort = await db.cohort.create({ data: { name: `DriftC ${stamp}`, courseId: cmpCourse.id } });

    const student = await db.student.create({
      data: {
        firstName: "Drift", lastName: "Tester", studentRef: `DRIFT${stamp}`,
        email: `drift.${stamp}@edtech.co.uk`, initials: "DT", colour: "#123456",
        cohortId: bizCohort.id, academicDepartmentId: biz.id,
      },
    });
    movedStudentId = student.id; originalCohortId = bizCohort.id;

    const res = await call(`/hnd/students/${student.id}`, {
      method: "PUT", token: adminToken, body: { cohortId: cmpCohort.id },
    });
    assert.equal(res.status, 200, `moving the student gave ${res.status} — ${JSON.stringify(res.body).slice(0, 200)}`);

    const after = await db.student.findUnique({ where: { id: student.id } });
    assert.equal(after.cohortId, cmpCohort.id, "the cohort did not move");
    assert.equal(after.academicDepartmentId, cmp.id,
      `the stored department did not follow the cohort (still ${after.academicDepartmentId})`);
    return "department followed the cohort";
  });
  /* ------------------------------------------------------------------------ */
  /* Assigning a department to a course directly                               */
  /* ------------------------------------------------------------------------ */

  // Breaks if: the course routes do not accept academicDepartmentId. Until they did, the
  // VLE mapping was the ONLY writer of Course.academicDepartmentId -- and it selects by
  // vleCategoryExternalId, which a hand-created course does not have. So a college that
  // does not run Moodle, or that adds a course in the app, could never assign it to a
  // department at all: its students stayed unassigned and invisible to their own tutors,
  // with the mapping screen telling the admin to "assign these on the course itself"
  // beside a control that did not exist.
  await check("a course created in the app can be given a department", async () => {
    const list = await call("/academic-departments", { token: adminToken });
    const biz = list.body.departments.find((d) => d.key === BIZ);
    const made = await call("/hnd/courses", {
      method: "POST", token: adminToken,
      body: { name: `Hand Made ${stamp}`, academicDepartmentId: biz.id },
    });
    assert.equal(made.status, 201, `expected 201, got ${made.status} — ${JSON.stringify(made.body)}`);
    handMadeCourseId = made.body.id;
    assert.equal(made.body.academicDepartmentId, biz.id, "the serialiser does not report the department");
    const row = await db.course.findUnique({ where: { id: handMadeCourseId } });
    assert.equal(row.academicDepartmentId, biz.id);
    return "created in Business";
  });

  // Breaks if: changing a course's department leaves its students behind. They would stay
  // visible to the department the course just left and hidden from the one it joined --
  // the same failure the VLE mapping does in one transaction, arriving through the other
  // door.
  await check("moving a course to another department moves its students too", async () => {
    const list = await call("/academic-departments", { token: adminToken });
    const biz = list.body.departments.find((d) => d.key === BIZ);
    const cmp = list.body.departments.find((d) => d.key === CMP);

    const cohort = await db.cohort.create({ data: { name: `HandCo ${stamp}`, courseId: handMadeCourseId } });
    handMadeCohortId = cohort.id;
    const st = await db.student.create({
      data: {
        firstName: "Hand", lastName: "Made", studentRef: `HAND${stamp}`,
        email: `hand.${stamp}@edtech.co.uk`, initials: "HM", colour: "#222222",
        cohortId: cohort.id, academicDepartmentId: biz.id,
      },
    });
    handMadeStudentId = st.id;

    const res = await call(`/hnd/courses/${handMadeCourseId}`, {
      method: "PUT", token: adminToken, body: { academicDepartmentId: cmp.id },
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status} — ${JSON.stringify(res.body)}`);
    const after = await db.student.findUnique({ where: { id: st.id } });
    assert.equal(after.academicDepartmentId, cmp.id, "the student did not follow the course");
    return "course and student both moved";
  });

  await check("an unknown department on a course is refused", async () => {
    const res = await call(`/hnd/courses/${handMadeCourseId}`, {
      method: "PUT", token: adminToken, body: { academicDepartmentId: "not-a-real-department" },
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    return "400";
  });

  // Omitting the field must leave the department alone -- a rename must not un-assign.
  await check("a course rename that omits the department leaves it untouched", async () => {
    const before = await db.course.findUnique({ where: { id: handMadeCourseId } });
    const res = await call(`/hnd/courses/${handMadeCourseId}`, {
      method: "PUT", token: adminToken, body: { name: `Hand Made Renamed ${stamp}` },
    });
    assert.equal(res.status, 200);
    const after = await db.course.findUnique({ where: { id: handMadeCourseId } });
    assert.equal(after.academicDepartmentId, before.academicDepartmentId, "a rename un-assigned the department");
    return "department untouched";
  });

  /* ------------------------------------------------------------------------ */
  /* Searching department-wise                                                 */
  /* ------------------------------------------------------------------------ */

  // A FILTER IS NOT A BOUNDARY, and keeping the two apart is the point of these
  // assertions. Scoping is enforced by the server and confines an account; this is a view
  // the user chooses, available to everybody, and it needs none of the nested-read work
  // that scoping is blocked on. A college can slice its own data by department today.
  await check("students can be searched by department", async () => {
    const list = await call("/academic-departments", { token: adminToken });
    const cmp = list.body.departments.find((d) => d.key === CMP);
    const res = await call(`/hnd/students?academicDepartmentId=${cmp.id}`, { token: adminToken });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const ids = (res.body || []).map((x) => x.id);
    assert.ok(ids.includes(movedStudentId), "the Computing student is missing from the Computing filter");
    assert.ok((res.body || []).every((x) => x.academicDepartmentId === cmp.id),
      "the filter returned a student from another department");
    return `${ids.length} student(s)`;
  });

  // THE QUESTION AN ADMINISTRATOR ACTUALLY HAS. The Settings screen reports "N students are
  // not assigned to a department" -- without this there is no way to see WHICH, so the
  // count is a number you cannot act on.
  await check("students not yet assigned can be listed with ?academicDepartmentId=none", async () => {
    const res = await call("/hnd/students?academicDepartmentId=none", { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.length > 0, "the seeded students should be unassigned");
    assert.ok(res.body.every((x) => x.academicDepartmentId === null),
      "the unassigned filter returned an assigned student");
    return `${res.body.length} unassigned`;
  });

  await check("courses can be searched by department, and by not-assigned", async () => {
    const list = await call("/academic-departments", { token: adminToken });
    const biz = list.body.departments.find((d) => d.key === BIZ);
    const inBiz = await call(`/hnd/courses?academicDepartmentId=${biz.id}`, { token: adminToken });
    assert.equal(inBiz.status, 200);
    assert.ok(inBiz.body.every((c) => c.academicDepartmentId === biz.id), "a course from another department leaked into the filter");
    const none = await call("/hnd/courses?academicDepartmentId=none", { token: adminToken });
    assert.ok(none.body.every((c) => c.academicDepartmentId === null), "an assigned course appeared under not-assigned");
    return `${inBiz.body.length} in Business, ${none.body.length} unassigned`;
  });

  // An unknown id returns an EMPTY list, not everything. A filter that silently ignores a
  // value it does not recognise shows the whole college under a department heading.
  await check("an unknown department id returns nothing, never everything", async () => {
    const res = await call("/hnd/students?academicDepartmentId=not-a-real-department", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 0, "an unrecognised filter returned rows");
    return "0 students";
  });

  await check("the student serialiser reports the department", async () => {
    const res = await call("/hnd/students", { token: adminToken });
    const row = res.body.find((x) => x.id === movedStudentId);
    assert.ok(row, "the fixture student is missing");
    assert.ok("academicDepartmentId" in row, "sStudent does not report the department, so no screen can group by it");
    return "present";
  });

  /* ------------------------------------------------------------------------ */
  /* The VLE category mapping                                                  */
  /* ------------------------------------------------------------------------ */

  await check("courses with no captured category are listed, not silently omitted", async () => {
    // A college whose Moodle predates the capture has EVERY course in this bucket, and a
    // screen that dropped them would report the mapping as finished before it had begun.
    const res = await call("/vle-department-mapping/categories", { token: adminToken });
    assert.equal(res.status, 200);
    const uncaptured = res.body.categories.find((c) => c.externalId === null);
    assert.ok(uncaptured, "the no-category bucket is missing entirely");
    assert.ok(uncaptured.courseCount > 0);
    // The department list rides along so the screen can render its pickers in one call.
    assert.ok(Array.isArray(res.body.departments), "the department list is missing");
    return `${uncaptured.courseCount} uncaptured course(s)`;
  });

  await check("a captured category is grouped with its course count and samples", async () => {
    const list = await call("/academic-departments", { token: adminToken });
    const biz = list.body.departments.find((d) => d.key === BIZ);
    mappingCourseIds = [];
    for (const n of [1, 2]) {
      const c = await db.course.create({
        data: { name: `VLE Cat ${n} ${stamp}`, vleCategoryExternalId: `cat-${stamp}` },
      });
      mappingCourseIds.push(c.id);
    }
    const res = await call("/vle-department-mapping/categories", { token: adminToken });
    const cat = res.body.categories.find((c) => c.externalId === `cat-${stamp}`);
    assert.ok(cat, "the captured category is missing");
    assert.equal(cat.courseCount, 2);
    assert.equal(cat.academicDepartmentId, null, "an unmapped category should report no department");
    assert.equal(cat.name, null, "a category whose name was never captured must report null, not a guess");
    assert.equal(cat.sampleCourses.length, 2);
    void biz;
    return "2 courses, unmapped";
  });

  // Breaks if: the student update is dropped from the transaction. Mapping the courses and
  // leaving the students behind hides a department's students from the very staff just
  // given that department — and the screen would report the mapping as done.
  await check("mapping a category moves its courses AND their students", async () => {
    const list = await call("/academic-departments", { token: adminToken });
    const biz = list.body.departments.find((d) => d.key === BIZ);

    const cohort = await db.cohort.create({ data: { name: `VLECo ${stamp}`, courseId: mappingCourseIds[0] } });
    mappingCohortId = cohort.id;
    const s = await db.student.create({
      data: {
        firstName: "Vle", lastName: "Mapped", studentRef: `VLE${stamp}`,
        email: `vle.${stamp}@edtech.co.uk`, initials: "VM", colour: "#654321",
        cohortId: cohort.id,
      },
    });
    mappingStudentId = s.id;

    const res = await call("/vle-department-mapping", {
      method: "PUT", token: boss.token,
      body: { externalId: `cat-${stamp}`, academicDepartmentId: biz.id },
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status} — ${JSON.stringify(res.body)}`);
    assert.equal(res.body.courseCount, 2);
    assert.equal(res.body.studentCount, 1, "the student was not moved with the course");

    const after = await db.student.findUnique({ where: { id: s.id } });
    assert.equal(after.academicDepartmentId, biz.id, "the student's stored department did not move");
    const c0 = await db.course.findUnique({ where: { id: mappingCourseIds[0] } });
    assert.equal(c0.academicDepartmentId, biz.id);
    return "2 courses, 1 student";
  });

  await check("an unknown department is refused and nothing is written", async () => {
    const res = await call("/vle-department-mapping", {
      method: "PUT", token: boss.token,
      body: { externalId: `cat-${stamp}`, academicDepartmentId: "not-a-real-department" },
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    const s = await db.student.findUnique({ where: { id: mappingStudentId } });
    assert.ok(s.academicDepartmentId, "the failed request un-assigned the student anyway");
    return "400, nothing changed";
  });

  // Breaks if: academicDepartmentId is coerced with str(), which returns "" for ANY
  // non-string and then falls to null. A client sending a NUMBER -- Moodle's own numeric
  // id, or Number(select.value), or a field-name typo -- would detach every course in the
  // category AND every student in their cohorts, return 200, and write an audit line
  // reading "un-assigned" as though it were intended. One request, every student in the
  // college, no error anywhere.
  await check("a non-string department id is refused, not read as un-assign", async () => {
    const before = await db.student.findUnique({ where: { id: mappingStudentId } });
    assert.ok(before.academicDepartmentId, "precondition: the student should be assigned");
    for (const bad of [42, ["x"], { id: "x" }, true]) {
      const res = await call("/vle-department-mapping", {
        method: "PUT", token: boss.token,
        body: { externalId: `cat-${stamp}`, academicDepartmentId: bad },
      });
      assert.equal(res.status, 400, `${JSON.stringify(bad)} gave ${res.status}, not 400`);
    }
    const after = await db.student.findUnique({ where: { id: mappingStudentId } });
    assert.equal(after.academicDepartmentId, before.academicDepartmentId, "a refused request un-assigned the student anyway");
    return "400 for each, nothing written";
  });

  // Un-assigning must still be possible, but only by saying so explicitly.
  await check("an explicit null still un-assigns", async () => {
    const res = await call("/vle-department-mapping", {
      method: "PUT", token: boss.token,
      body: { externalId: `cat-${stamp}`, academicDepartmentId: null },
    });
    assert.equal(res.status, 200, `explicit null gave ${res.status}`);
    const after = await db.student.findUnique({ where: { id: mappingStudentId } });
    assert.equal(after.academicDepartmentId, null);
    return "un-assigned on purpose";
  });

  await check("a category nobody has is a 404, not a silent success", async () => {
    // academicDepartmentId is sent EXPLICITLY as null. Omitting it is now a 400 -- an
    // absent field must not mean the same thing as a deliberate un-assign, because that
    // is how a field-name typo detached a whole category.
    const res = await call("/vle-department-mapping", {
      method: "PUT", token: boss.token, body: { externalId: `nope-${stamp}`, academicDepartmentId: null },
    });
    assert.equal(res.status, 404);
    return "404";
  });

  await check("a mapped category reports the department it is mapped to", async () => {
    // Re-mapped first: the explicit-null assertion above deliberately un-assigned this
    // category, so without this the assertion would be reading that un-assign back.
    const list0 = await call("/academic-departments", { token: adminToken });
    const biz0 = list0.body.departments.find((d) => d.key === BIZ);
    const remap = await call("/vle-department-mapping", {
      method: "PUT", token: boss.token, body: { externalId: `cat-${stamp}`, academicDepartmentId: biz0.id },
    });
    assert.equal(remap.status, 200, `re-map gave ${remap.status}`);
    const res = await call("/vle-department-mapping/categories", { token: adminToken });
    const cat = res.body.categories.find((c) => c.externalId === `cat-${stamp}`);
    const list = await call("/academic-departments", { token: adminToken });
    const biz = list.body.departments.find((d) => d.key === BIZ);
    assert.equal(cat.academicDepartmentId, biz.id);
    assert.equal(cat.splitAcross, null);
    return "mapped, not split";
  });

  // SPLIT IS A REAL STATE. It means somebody assigned courses by hand, and flattening it
  // to "unmapped" would invite an administrator to overwrite deliberate work with a click.
  await check("a category split across two departments reports it rather than hiding it", async () => {
    const list = await call("/academic-departments", { token: adminToken });
    const cmp = list.body.departments.find((d) => d.key === CMP);
    await db.course.update({ where: { id: mappingCourseIds[1] }, data: { academicDepartmentId: cmp.id } });
    const res = await call("/vle-department-mapping/categories", { token: adminToken });
    const cat = res.body.categories.find((c) => c.externalId === `cat-${stamp}`);
    assert.equal(cat.academicDepartmentId, null, "a split category must not claim one department");
    assert.equal(cat.splitAcross?.length, 2, "the split was not reported");
    return "split across 2";
  });
} finally {
  /* -------------------------------------------------------------------------- */
  /* Cleanup — in a finally, so a failed run leaves nothing behind               */
  /* -------------------------------------------------------------------------- */
  if (handMadeStudentId) await db.student.deleteMany({ where: { id: handMadeStudentId } }).catch(() => {});
  if (handMadeCohortId) await db.cohort.deleteMany({ where: { id: handMadeCohortId } }).catch(() => {});
  if (handMadeCourseId) await db.course.deleteMany({ where: { id: handMadeCourseId } }).catch(() => {});
  if (mappingStudentId) await db.student.deleteMany({ where: { id: mappingStudentId } }).catch(() => {});
  if (mappingCohortId) await db.cohort.deleteMany({ where: { id: mappingCohortId } }).catch(() => {});
  if (mappingCourseIds.length) await db.course.deleteMany({ where: { id: { in: mappingCourseIds } } }).catch(() => {});
  if (movedStudentId) await db.student.deleteMany({ where: { id: movedStudentId } }).catch(() => {});
  await db.cohort.deleteMany({ where: { name: { in: [`DriftB ${stamp}`, `DriftC ${stamp}`] } } }).catch(() => {});
  await db.course.deleteMany({ where: { name: { in: [`Retire Test ${stamp}`, `Drift Biz ${stamp}`, `Drift Cmp ${stamp}`] } } }).catch(() => {});
  await db.staffAcademicDepartment.deleteMany({ where: { staffId: { in: Object.values(people).map((p) => p.id) } } }).catch(() => {});
  await db.staff.deleteMany({ where: { email: { in: Object.values(people).map((p) => p.email) } } }).catch(() => {});
  // The departments go last, after every row that pointed at them.
  await db.academicDepartment.deleteMany({ where: { key: { in: [BIZ, CMP] } } }).catch(() => {});
  await db.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
