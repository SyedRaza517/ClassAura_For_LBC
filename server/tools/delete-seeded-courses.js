// Removes the four hand-made / seeded courses that predate the Moodle import,
// together with their units, assessments, marks, enrolments, sessions, attendance,
// cohorts and terms.
//
// SAFETY: a course is only touched when BOTH hold —
//   1. it is NOT linked to Moodle (moodleCourseId is null), and
//   2. its name is one of the four listed below.
// Either check alone would be enough; requiring both means a typo or a future
// Moodle re-link cannot make this script reach a real course.
//
// Students are NOT deleted. Cohort → Student is set-null, so every student record
// survives with its cohort cleared; the Moodle sync owns the student list now.
//
//   node delete-seeded-courses.js            ← shows what would go, deletes nothing
//   node delete-seeded-courses.js --confirm  ← actually deletes it
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const prisma = require("../src/db");
const { withoutAcademicScope } = require("../src/academicScope");

const NAMES = [
  "HND Leadership and Management",
  "HND Sustainable Business Management",
  "Pearson BTEC Level 5 Higher National Diploma in Business",
  "Testing",
];

const CONFIRM = process.argv.includes("--confirm");

// AN OPERATOR CLI HAS NO CALLER AND THEREFORE NO DEPARTMENT.
//
// It is run from a shell by somebody with database access, over the whole institution by
// definition. Without this declaration the academic scope guard throws on its first query
// against Student, Course, Enrolment or AttendanceMark -- which is what happened to all
// seven tools in this directory when the guard went live, because prisma/seed.js was
// wrapped and these were forgotten.
withoutAcademicScope("delete-seeded-courses: an operator CLI that removes demo data college-wide", async () => {
  const courses = await prisma.course.findMany({ where: { name: { in: NAMES }, moodleCourseId: null } });

  if (!courses.length) {
    console.log("\nNothing to do — none of those courses are present (or they are now linked to Moodle).\n");
    await prisma.$disconnect();
    return;
  }

  // Anything that names a course but is NOT one of these must be left alone. Report
  // it so a mismatch is visible rather than silent.
  const missing = NAMES.filter((n) => !courses.some((c) => c.name === n));
  if (missing.length) console.log(`\nNote: not found (or Moodle-linked, so skipped): ${missing.map((n) => `"${n}"`).join(", ")}`);

  const total = { units: 0, assessments: 0, grades: 0, enrolments: 0, sessions: 0, attendance: 0, cohorts: 0, terms: 0 };
  const plan = [];

  for (const c of courses) {
    const units = await prisma.unit.findMany({ where: { courseId: c.id }, select: { id: true, code: true } });
    const unitIds = units.map((u) => u.id);
    const assessments = unitIds.length ? await prisma.assessment.findMany({ where: { unitId: { in: unitIds } }, select: { id: true } }) : [];
    const sessions = unitIds.length ? await prisma.hndSession.findMany({ where: { unitId: { in: unitIds } }, select: { id: true } }) : [];
    const cohorts = await prisma.cohort.findMany({ where: { courseId: c.id }, select: { id: true } });
    const cohortIds = cohorts.map((x) => x.id);

    const counts = {
      units: units.length,
      assessments: assessments.length,
      grades: assessments.length ? await prisma.assessmentGrade.count({ where: { assessmentId: { in: assessments.map((a) => a.id) } } }) : 0,
      enrolments: unitIds.length ? await prisma.enrolment.count({ where: { unitId: { in: unitIds } } }) : 0,
      sessions: sessions.length,
      attendance: sessions.length ? await prisma.attendanceMark.count({ where: { sessionId: { in: sessions.map((s) => s.id) } } }) : 0,
      cohorts: cohorts.length,
      terms: cohortIds.length ? await prisma.term.count({ where: { cohortId: { in: cohortIds } } }) : 0,
    };
    for (const k of Object.keys(total)) total[k] += counts[k];
    plan.push({ course: c, unitIds, units, counts });
  }

  console.log(`\n${CONFIRM ? "DELETING" : "WOULD DELETE"} ${courses.length} course(s)\n${"═".repeat(72)}`);
  for (const p of plan) {
    console.log(`\n"${p.course.name}"`);
    console.log(`   units ${p.counts.units}${p.counts.units ? ` (${p.units.map((u) => u.code).join(", ")})` : ""}`);
    console.log(`   assessments ${p.counts.assessments} · marks ${p.counts.grades} · enrolments ${p.counts.enrolments}`);
    console.log(`   sessions ${p.counts.sessions} · attendance ${p.counts.attendance} · cohorts ${p.counts.cohorts} · terms ${p.counts.terms}`);
  }
  console.log(`\n${"═".repeat(72)}`);
  console.log(`TOTAL  courses ${courses.length} · units ${total.units} · assessments ${total.assessments} · marks ${total.grades}`);
  console.log(`       enrolments ${total.enrolments} · sessions ${total.sessions} · attendance ${total.attendance} · cohorts ${total.cohorts} · terms ${total.terms}`);
  console.log(`Students deleted: 0 — every student record is kept.`);

  if (!CONFIRM) {
    console.log(`\nNothing was changed. Re-run with --confirm to delete.\n`);
    await prisma.$disconnect();
    return;
  }

  // One transaction: either the whole set goes or none of it does, so a failure
  // part-way cannot leave half-deleted courses behind.
  await prisma.$transaction(async (tx) => {
    for (const p of plan) {
      // Units are set-null on course delete, so they must go explicitly. Their
      // assessments, grades, enrolments, sessions and attendance all cascade.
      if (p.unitIds.length) await tx.unit.deleteMany({ where: { id: { in: p.unitIds } } });
      // Deleting the course cascades its cohorts, and each cohort cascades its terms.
      await tx.course.delete({ where: { id: p.course.id } });
    }
  });

  console.log(`\n✓ Deleted.`);
  console.log(`  Courses left    : ${await prisma.course.count()}`);
  console.log(`  Units left      : ${await prisma.unit.count()}`);
  console.log(`  Assessments left: ${await prisma.assessment.count()}`);
  console.log(`  Marks left      : ${await prisma.assessmentGrade.count()}`);
  console.log(`  Students left   : ${await prisma.student.count()}\n`);
  await prisma.$disconnect();
}).catch(async (e) => { console.error("\n✗ Failed:", e.message, "\n"); await prisma.$disconnect(); process.exitCode = 1; });
