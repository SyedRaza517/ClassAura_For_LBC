// Narrow every seeded account to ONE academic department that owns everything.
//
// WHY THIS EXISTS. Every smoke suite signs in as an admin who is college-wide, so
// scopePredicateFor returns null and the guard's FILTERED branch is never executed once.
// Spec 1 shipped 30 green suites while the boundary leaked 194 attendance marks through a
// nested include, and no test noticed, because no test was ever on the other side of the
// branch. `SMOKE_SCOPED_DEPARTMENT=1 npm test` runs the whole suite through that branch.
//
// THE DEPARTMENT OWNS EVERY SEEDED COURSE, STUDENT, UNIT AND COHORT, so every existing
// assertion should still hold exactly as written. That is the point: this is not a test of
// scoping, it is a test that scoping did not BREAK anything. A suite that fails under the
// flag has found a query the filtering changed, and the route is what gets fixed — never
// the guard, and never the assertion.
//
// Run only against a disposable database, like the seed it follows.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
require("./assertDisposable").assertDisposable("prisma/scope-all-staff.js rewrites staff access and department assignment");
const prisma = require("../src/db");
// Institution-wide by nature: it is assigning the whole college to a department, from a
// shell, with no caller and no scope of its own.
const { withoutAcademicScope } = require("../src/academicScope");

const KEY = "smoke-all";

withoutAcademicScope("scope-all-staff: assigns the whole college to one department", async () => {
  const dept = await prisma.academicDepartment.upsert({
    where: { key: KEY },
    update: { active: true },
    create: { key: KEY, name: "Everything (smoke)", colour: "#1a3a8f" },
  });

  // Everything the seed created, into that one department. Courses first so that anything
  // deriving from a course is consistent with it.
  const courses = await prisma.course.updateMany({ data: { academicDepartmentId: dept.id } });
  const cohorts = await prisma.cohort.updateMany({ data: { academicDepartmentId: dept.id } });
  const units = await prisma.unit.updateMany({ data: { academicDepartmentId: dept.id } });
  const students = await prisma.student.updateMany({ data: { academicDepartmentId: dept.id } });

  // TIMETABLE ROWS ARE LEFT ALONE, deliberately. Null there means "shown to everyone", and
  // assigning them would hide the fail-open path this flag most needs to exercise: a
  // course-less workshop must stay visible to a narrowed account, and the only way to test
  // that is to leave some course-less rows unassigned.

  // Every staff account is narrowed, INCLUDING the Super Admin. A flag that quietly exempted
  // the account most suites sign in as would exercise nothing.
  const staff = await prisma.staff.findMany({ select: { id: true } });
  await prisma.staff.updateMany({ data: { collegeWide: false } });
  await prisma.staffAcademicDepartment.deleteMany({});
  for (const s of staff) {
    await prisma.staffAcademicDepartment.create({
      data: { staffId: s.id, academicDepartmentId: dept.id },
    });
  }

  console.log(
    `Narrowed ${staff.length} staff account(s) to "${dept.name}" — ` +
    `${courses.count} course(s), ${cohorts.count} cohort(s), ${units.count} unit(s), ${students.count} student(s).`,
  );
})
  .catch((e) => { console.error("\n✗ scope-all-staff failed:", e.message, "\n"); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
