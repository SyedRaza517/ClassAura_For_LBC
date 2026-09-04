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

  await check("a bad colour and a bad key are cleaned rather than stored", async () => {
    const put = await call("/academic-departments", {
      method: "PUT", token: adminToken,
      body: { departments: [
        { key: BIZ, name: "Business", colour: "javascript:alert(1)" },
        { key: CMP, name: "Computing" },
        { key: "NOT A KEY", name: "Rejected" },
      ] },
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.departments.find((d) => d.key === BIZ).colour, "#1a3a8f");
    assert.ok(!put.body.departments.some((d) => d.name === "Rejected"), "an invalid key was stored");
    return "colour reset, bad key dropped";
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

  await check("the Super Admin can scope a member of staff to one department", async () => {
    const list = await call("/academic-departments", { token: adminToken });
    const biz = list.body.departments.find((d) => d.key === BIZ);
    const res = await call(`/academic-departments/staff/${plain.id}`, {
      method: "PUT", token: boss.token, body: { academicDepartmentIds: [biz.id], collegeWide: false },
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status} — ${JSON.stringify(res.body)}`);
    const rows = await db.staffAcademicDepartment.findMany({ where: { staffId: plain.id } });
    assert.deepEqual(rows.map((r) => r.academicDepartmentId), [biz.id]);
    const s = await db.staff.findUnique({ where: { id: plain.id } });
    assert.equal(s.collegeWide, false);
    return "1 department, collegeWide false";
  });

  // Breaks if: an unknown id is silently dropped. The Access screen would then show a
  // grant that was never made, which is worse than an error somebody can act on.
  await check("an unknown department id is refused, not silently dropped", async () => {
    const res = await call(`/academic-departments/staff/${plain.id}`, {
      method: "PUT", token: boss.token, body: { academicDepartmentIds: ["not-a-real-id"], collegeWide: false },
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    const rows = await db.staffAcademicDepartment.findMany({ where: { staffId: plain.id } });
    assert.equal(rows.length, 1, "the failed request changed the membership anyway");
    return "400, membership unchanged";
  });

  await check("collegeWide is set only by an exact true, never by a truthy value", async () => {
    const res = await call(`/academic-departments/staff/${plain.id}`, {
      method: "PUT", token: boss.token, body: { academicDepartmentIds: [], collegeWide: "yes" },
    });
    assert.equal(res.status, 200);
    const s = await db.staff.findUnique({ where: { id: plain.id } });
    assert.equal(s.collegeWide, false, '"yes" was read as college-wide access');
    return "still false";
  });

  await check("a staff member who does not exist gives 404", async () => {
    const res = await call("/academic-departments/staff/nobody", {
      method: "PUT", token: boss.token, body: { academicDepartmentIds: [], collegeWide: false },
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
} finally {
  /* -------------------------------------------------------------------------- */
  /* Cleanup — in a finally, so a failed run leaves nothing behind               */
  /* -------------------------------------------------------------------------- */
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
