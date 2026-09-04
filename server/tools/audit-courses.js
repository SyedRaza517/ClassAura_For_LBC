// READ ONLY. Lists every course and exactly what hangs off it, so you can see what
// a delete would take with it before anything is deleted.
//
//   node audit-courses.js
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const prisma = require("../src/db");
const { withoutAcademicScope } = require("../src/academicScope");

// AN OPERATOR CLI HAS NO CALLER AND THEREFORE NO DEPARTMENT.
//
// It is run from a shell by somebody with database access, over the whole institution by
// definition. Without this declaration the academic scope guard throws on its first query
// against Student, Course, Enrolment or AttendanceMark -- which is what happened to all
// seven tools in this directory when the guard went live, because prisma/seed.js was
// wrapped and these were forgotten.
withoutAcademicScope("audit-courses: an operator CLI that reports on the whole college", async () => {
  const courses = await prisma.course.findMany({ orderBy: { name: "asc" } });
  const looseUnits = await prisma.unit.findMany({ where: { courseId: null } });

  console.log(`\nCOURSES IN THE DATABASE (${courses.length})\n${"═".repeat(78)}`);

  for (const c of courses) {
    const units = await prisma.unit.findMany({ where: { courseId: c.id }, orderBy: { code: "asc" } });
    const unitIds = units.map((u) => u.id);
    const [assessments, enrolments, sessions, cohorts] = await Promise.all([
      unitIds.length ? prisma.assessment.count({ where: { unitId: { in: unitIds } } }) : 0,
      unitIds.length ? prisma.enrolment.count({ where: { unitId: { in: unitIds } } }) : 0,
      unitIds.length ? prisma.hndSession.count({ where: { unitId: { in: unitIds } } }) : 0,
      prisma.cohort.count({ where: { courseId: c.id } }),
    ]);
    const assessIds = unitIds.length
      ? (await prisma.assessment.findMany({ where: { unitId: { in: unitIds } }, select: { id: true } })).map((a) => a.id)
      : [];
    const grades = assessIds.length ? await prisma.assessmentGrade.count({ where: { assessmentId: { in: assessIds } } }) : 0;
    const sessionIds = unitIds.length
      ? (await prisma.hndSession.findMany({ where: { unitId: { in: unitIds } }, select: { id: true } })).map((s) => s.id)
      : [];
    const marks = sessionIds.length ? await prisma.attendanceMark.count({ where: { sessionId: { in: sessionIds } } }) : 0;

    console.log(`\n"${c.name}"`);
    console.log(`   id ${c.id}${c.moodleCourseId ? `   ← linked to Moodle course ${c.moodleCourseId}` : "   (not linked to Moodle)"}`);
    console.log(`   units ${units.length} · assessments ${assessments} · marks ${grades} · enrolments ${enrolments} · sessions ${sessions} · attendance ${marks} · cohorts ${cohorts}`);
    if (units.length) console.log(`   ${units.map((u) => u.code).join(", ")}`);
  }

  console.log(`\n${"═".repeat(78)}`);
  console.log(`Units with NO course: ${looseUnits.length}${looseUnits.length ? ` — ${looseUnits.map((u) => u.code).join(", ")}` : ""}`);
  console.log(`Students in total   : ${await prisma.student.count()}`);
  console.log(`Assessments in total: ${await prisma.assessment.count()}`);
  console.log(`Marks in total      : ${await prisma.assessmentGrade.count()}`);
  console.log(`${"═".repeat(78)}\nNothing was changed.\n`);
  await prisma.$disconnect();
}).catch(async (e) => { console.error("\n✗ Audit failed:", e.message, "\n"); await prisma.$disconnect(); process.exitCode = 1; });
