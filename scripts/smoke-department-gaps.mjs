// Smoke test: the places where the departmental boundary did not hold (28 Sep 2026).
//
// smoke-academic-departments.mjs proves the boundary confines READS. This suite covers
// what it could not: whole-college JOBS a narrowed admin could start (the monthly letter
// run, a Moodle sync, a Teams run), responses that carry student names as free text (the
// audit trail, sync issue lists), department management a narrowed planner could reach,
// a course a narrowed admin could file under someone else's department, and a nested
// include the guard never rewrote (an extension on another department's claim).
//
// WEIGHTED NEGATIVE, as testing.md asks, and every refusal is paired with the permission
// that makes it mean something: a narrowed account that could do NOTHING would pass every
// "refused" assertion here while discriminating nothing about departments. So each block
// also shows the same account succeeding inside its own department, or a college-wide
// account succeeding where the narrowed one is refused.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(pathToFileURL(join(ROOT, "server", "package.json")));
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);

const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const BASE = process.env.API_URL || "http://localhost:4010/api";
const ADMIN = process.env.SEED_ADMIN_EMAIL || "admin@edtech.co.uk";
const PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";

let passed = 0, failed = 0;
const ok = (label, detail) => { passed++; console.log(`✓ ${label}${detail ? "  — " + detail : ""}`); };
const bad = (label, e) => { failed++; console.log(`✗ ${label}\n    ${e && e.message ? e.message : e}`); };
async function check(label, fn) {
  try { ok(label, await fn()); } catch (e) { bad(label, e); }
}
const call = async (path, { method = "GET", body, token } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
};

// A REFUSAL FROM THE DEPARTMENT GATE, not from a missing page. The narrowed account holds
// every page these routes ask for, so a 403 without this code would be the wrong gate
// answering -- and would pass a bare status check while proving nothing about departments.
const refusedAsNarrowed = (res, what) => {
  assert.equal(res.status, 403, `${what}: expected 403, got ${res.status} — ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.code, "COLLEGE_WIDE_REQUIRED", `${what}: refused, but not by the department gate — ${JSON.stringify(res.body)}`);
};

const admin = await call("/auth/login", { method: "POST", body: { email: ADMIN, password: PASSWORD } });
if (!admin.body?.token) { console.log(`✗ could not sign in as ${ADMIN}`); process.exit(1); }
const adminToken = admin.body.token;

const stamp = Date.now();
const fx = {
  depts: [], courses: [], cohorts: [], units: [], students: [], assessments: [],
  claims: [], moodleSyncs: [], staff: null,
};

try {
  /* ------------------------------------------------------------------------ */
  /* Fixtures: two departments, a student and a claim in each, and an admin   */
  /* narrowed to Business who holds every page the routes below ask for.      */
  /* ------------------------------------------------------------------------ */
  const biz = await db.academicDepartment.create({ data: { key: `gbiz-${stamp}`, name: `Gaps Business ${stamp}` } });
  const cmp = await db.academicDepartment.create({ data: { key: `gcmp-${stamp}`, name: `Gaps Computing ${stamp}` } });
  fx.depts.push(biz.id, cmp.id);

  const side = {};
  for (const [tag, dept] of [["BIZ", biz], ["CMP", cmp]]) {
    const course = await db.course.create({ data: { name: `Gaps ${tag} ${stamp}`, academicDepartmentId: dept.id } });
    const cohort = await db.cohort.create({ data: { name: `Gaps${tag} ${stamp}`, courseId: course.id, academicDepartmentId: dept.id } });
    const unit = await db.unit.create({ data: { code: `G${tag}${stamp}`.slice(0, 20), name: `Gaps unit ${tag}`, courseId: course.id, academicDepartmentId: dept.id } });
    const student = await db.student.create({
      data: {
        firstName: "Gaps", lastName: tag, studentRef: `GAPS${tag}${stamp}`,
        email: `gaps.${tag.toLowerCase()}.${stamp}@edtech.co.uk`, initials: "GP", colour: "#445566",
        cohortId: cohort.id, academicDepartmentId: dept.id,
      },
    });
    const assessment = await db.assessment.create({ data: { unitId: unit.id, title: `Gaps essay ${tag}` } });
    const claim = await db.mitigatingCircumstance.create({
      data: { studentId: student.id, status: "approved", coversFrom: "2026-09-01", coversTo: "2026-09-30", raisedOn: "2026-09-01" },
    });
    const adjustment = await db.assessmentAdjustment.create({
      data: { circumstanceId: claim.id, assessmentId: assessment.id, adjustmentType: "extension", revisedDueDate: "2026-10-15" },
    });
    fx.courses.push(course.id); fx.cohorts.push(cohort.id); fx.units.push(unit.id);
    fx.students.push(student.id); fx.assessments.push(assessment.id); fx.claims.push(claim.id);
    side[tag] = { course, claim, adjustment };
  }

  const email = `gaps.narrow.${stamp}@edtech.co.uk`, pw = "NarrowPass123!";
  const made = await call("/staff", { method: "POST", token: adminToken, body: { name: "Gaps Narrow Admin", email, password: pw } });
  if (!made.body?.id) throw new Error(`could not create the narrowed fixture — ${JSON.stringify(made.body)}`);
  fx.staff = made.body.id;
  await db.staff.update({
    where: { id: fx.staff },
    data: {
      accountRole: "ADMIN", mustChangePassword: false, collegeWide: false,
      adminPages: JSON.stringify([
        "settings", "registers", "students", "attendance-emails", "scheduling",
        "attendance-settings", "staff", "mitigations",
      ]),
    },
  });
  await db.staffAcademicDepartment.create({ data: { staffId: fx.staff, academicDepartmentId: biz.id } });
  const login = await call("/auth/login", { method: "POST", body: { email, password: pw } });
  if (!login.body?.token) throw new Error("the narrowed fixture could not sign in");
  const narrow = login.body.token;

  /* ------------------------------------------------------------------------ */
  /* Whole-college jobs                                                        */
  /* ------------------------------------------------------------------------ */
  await check("a narrowed admin cannot start the monthly attendance-letter run", async () => {
    refusedAsNarrowed(await call("/attendance-emails/run", { method: "POST", token: narrow, body: { force: true } }), "/attendance-emails/run");
    return "403 COLLEGE_WIDE_REQUIRED";
  });

  await check("a narrowed admin cannot preview or start a Moodle sync", async () => {
    refusedAsNarrowed(await call("/moodle/preview", { token: narrow }), "/moodle/preview");
    refusedAsNarrowed(await call("/moodle/sync", { method: "POST", token: narrow }), "/moodle/sync");
    // The permission half: a college-wide admin passes the department gate. Moodle is not
    // configured on a test server, so it answers 400 rather than 200 -- anything but the
    // department refusal proves the gate lets college-wide callers through.
    const wide = await call("/moodle/preview", { token: adminToken });
    assert.notEqual(wide.body?.code, "COLLEGE_WIDE_REQUIRED", "a college-wide admin was refused by the department gate");
    return `narrowed 403 ×2, college-wide ${wide.status}`;
  });

  await check("a narrowed admin cannot start Teams runs", async () => {
    refusedAsNarrowed(await call("/teams-attendance/sync", { method: "POST", token: narrow }), "/teams-attendance/sync");
    refusedAsNarrowed(await call("/teams-automation/run-meetings", { method: "POST", token: narrow }), "/teams-automation/run-meetings");
    refusedAsNarrowed(await call("/teams-automation/run-provisioning", { method: "POST", token: narrow }), "/teams-automation/run-provisioning");
    return "403 ×3";
  });

  /* ------------------------------------------------------------------------ */
  /* Free text that names students                                             */
  /* ------------------------------------------------------------------------ */
  await check("the audit trail is refused to a narrowed admin and served to a college-wide one", async () => {
    refusedAsNarrowed(await call("/audit", { token: narrow }), "/audit");
    refusedAsNarrowed(await call("/audit/actions", { token: narrow }), "/audit/actions");
    const wide = await call("/audit", { token: adminToken });
    assert.equal(wide.status, 200, `a college-wide admin could not read the audit trail — ${wide.status}`);
    return "narrowed 403, college-wide 200";
  });

  await check("Moodle run issues are withheld from a narrowed admin, and shown to a college-wide one", async () => {
    const marker = `Gaps Leak Student ${stamp}`;
    const run = await db.moodleSync.create({
      data: { status: "ok", mode: "manual", finishedAt: new Date(), startedAt: new Date(Date.now() + 60_000), issues: JSON.stringify([`${marker} has no email`]) },
    });
    fx.moodleSyncs.push(run.id);
    const n = await call("/moodle/status", { token: narrow });
    assert.equal(n.status, 200, `status should stay readable — ${n.status}`);
    const nRow = (n.body.history || []).find((r) => r.id === run.id);
    assert.ok(nRow, "the fixture run is missing from the narrowed history");
    assert.deepEqual(nRow.issues, [], "a narrowed admin read a college-wide issue list");
    assert.equal(nRow.issuesWithheld, true, "the withholding was not flagged, so the screen would read it as 'no issues'");
    assert.ok(!JSON.stringify(n.body).includes(marker), "the student's name reached the narrowed response somewhere");

    const w = await call("/moodle/status", { token: adminToken });
    const wRow = (w.body.history || []).find((r) => r.id === run.id);
    assert.ok(wRow?.issues?.some((m) => m.includes(marker)), "a college-wide admin lost the issue list too");
    assert.equal(wRow.issuesWithheld, false);
    return "withheld / shown";
  });

  /* ------------------------------------------------------------------------ */
  /* Managing departments                                                      */
  /* ------------------------------------------------------------------------ */
  await check("a narrowed planner cannot delete, rename or retire a school", async () => {
    refusedAsNarrowed(await call(`/timetabling/departments/${cmp.id}`, { method: "DELETE", token: narrow }), "DELETE school");
    refusedAsNarrowed(await call(`/timetabling/departments/${cmp.id}`, { method: "PUT", token: narrow, body: { name: "Renamed" } }), "PUT school");
    const still = await db.academicDepartment.findUnique({ where: { id: cmp.id } });
    assert.ok(still && still.active && still.name === cmp.name, "the school was changed despite the refusal");
    return "403, untouched";
  });

  await check("a narrowed planner can still ADD a school", async () => {
    const res = await call("/timetabling/departments", { method: "POST", token: narrow, body: { name: `Gaps Added ${stamp}` } });
    assert.equal(res.status, 201, `expected 201, got ${res.status} — ${JSON.stringify(res.body)}`);
    fx.depts.push(res.body.id);
    return "201";
  });

  await check("a school with courses in it is retired, not deleted, by a college-wide planner", async () => {
    const res = await call(`/timetabling/departments/${cmp.id}`, { method: "DELETE", token: adminToken });
    assert.equal(res.status, 200, `expected 200, got ${res.status} — ${JSON.stringify(res.body)}`);
    assert.equal(res.body.retired, true, "a school still holding courses and students was hard-deleted");
    assert.ok(res.body.counts.students >= 1, "the in-use count missed the school's student");
    await db.academicDepartment.update({ where: { id: cmp.id }, data: { active: true } });
    return `retired, ${res.body.inUse} in use`;
  });

  await check("a narrowed admin cannot rewrite the department list on Settings", async () => {
    refusedAsNarrowed(await call("/academic-departments", { method: "PUT", token: narrow, body: { departments: [] } }), "PUT /academic-departments");
    const both = await db.academicDepartment.count({ where: { id: { in: [biz.id, cmp.id] }, active: true } });
    assert.equal(both, 2, "a department was retired despite the refusal");
    return "403, both still active";
  });

  /* ------------------------------------------------------------------------ */
  /* Filing a course                                                           */
  /* ------------------------------------------------------------------------ */
  await check("a narrowed admin cannot create a course in another department", async () => {
    const res = await call("/hnd/courses", { method: "POST", token: narrow, body: { name: `Gaps Foreign ${stamp}`, academicDepartmentId: cmp.id } });
    assert.equal(res.status, 403, `expected 403, got ${res.status} — ${JSON.stringify(res.body)}`);
    const made = await db.course.findFirst({ where: { name: `Gaps Foreign ${stamp}` } });
    if (made) fx.courses.push(made.id);
    assert.ok(!made, "the course was created anyway");
    return "403, nothing written";
  });

  await check("...but can create one in their own, and by default lands there", async () => {
    const own = await call("/hnd/courses", { method: "POST", token: narrow, body: { name: `Gaps Own ${stamp}`, academicDepartmentId: biz.id } });
    assert.equal(own.status, 201, `own department refused — ${own.status} ${JSON.stringify(own.body)}`);
    fx.courses.push(own.body.id);
    const dflt = await call("/hnd/courses", { method: "POST", token: narrow, body: { name: `Gaps Default ${stamp}` } });
    assert.equal(dflt.status, 201, `no-department create refused — ${dflt.status} ${JSON.stringify(dflt.body)}`);
    fx.courses.push(dflt.body.id);
    const row = await db.course.findUnique({ where: { id: dflt.body.id } });
    assert.equal(row.academicDepartmentId, biz.id, "a narrowed admin's course did not default to their department");
    return "201 ×2, defaulted to Business";
  });

  await check("a narrowed admin cannot move their course out, or un-assign it", async () => {
    const out = await call(`/hnd/courses/${side.BIZ.course.id}`, { method: "PUT", token: narrow, body: { academicDepartmentId: cmp.id } });
    assert.equal(out.status, 403, `move to another department: expected 403, got ${out.status}`);
    const unassign = await call(`/hnd/courses/${side.BIZ.course.id}`, { method: "PUT", token: narrow, body: { academicDepartmentId: null } });
    assert.equal(unassign.status, 403, `un-assign: expected 403, got ${unassign.status}`);
    const row = await db.course.findUnique({ where: { id: side.BIZ.course.id } });
    assert.equal(row.academicDepartmentId, biz.id, "the course moved despite the refusal");
    return "403 ×2, still Business";
  });

  /* ------------------------------------------------------------------------ */
  /* The nested include                                                        */
  /* ------------------------------------------------------------------------ */
  await check("a narrowed admin cannot delete an extension on another department's claim", async () => {
    const { claim, adjustment } = side.CMP;
    const res = await call(`/mitigations/${claim.id}/adjustments/${adjustment.id}`, { method: "DELETE", token: narrow });
    assert.equal(res.status, 404, `expected 404, got ${res.status} — ${JSON.stringify(res.body)}`);
    assert.ok(await db.assessmentAdjustment.findUnique({ where: { id: adjustment.id } }), "the Computing extension was deleted");
    return "404, extension kept";
  });

  await check("...and can delete one on their own department's claim", async () => {
    const { claim, adjustment } = side.BIZ;
    const res = await call(`/mitigations/${claim.id}/adjustments/${adjustment.id}`, { method: "DELETE", token: narrow });
    assert.equal(res.status, 200, `own claim refused — ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(await db.assessmentAdjustment.findUnique({ where: { id: adjustment.id } }), null, "the Business extension survived");
    return "200, removed";
  });
} catch (e) {
  bad("fixture setup", e);
} finally {
  /* -------------------------------------------------------------------------- */
  /* Cleanup — in a finally, so a failed run leaves nothing behind               */
  /* -------------------------------------------------------------------------- */
  await db.moodleSync.deleteMany({ where: { id: { in: fx.moodleSyncs } } }).catch(() => {});
  await db.assessmentAdjustment.deleteMany({ where: { circumstanceId: { in: fx.claims } } }).catch(() => {});
  await db.mitigatingCircumstance.deleteMany({ where: { id: { in: fx.claims } } }).catch(() => {});
  await db.assessment.deleteMany({ where: { id: { in: fx.assessments } } }).catch(() => {});
  await db.student.deleteMany({ where: { id: { in: fx.students } } }).catch(() => {});
  await db.unit.deleteMany({ where: { id: { in: fx.units } } }).catch(() => {});
  await db.cohort.deleteMany({ where: { id: { in: fx.cohorts } } }).catch(() => {});
  await db.course.deleteMany({ where: { id: { in: fx.courses } } }).catch(() => {});
  if (fx.staff) {
    await db.staffAcademicDepartment.deleteMany({ where: { staffId: fx.staff } }).catch(() => {});
    await db.staff.deleteMany({ where: { id: fx.staff } }).catch(() => {});
  }
  // The departments go last, after every row that pointed at them.
  await db.academicDepartment.deleteMany({ where: { id: { in: fx.depts } } }).catch(() => {});
  await db.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
