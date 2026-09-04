// READ ONLY — how much of Moodle's attendance could actually be imported, and what
// would be left behind. Writes nothing to either system.
//
// Run from server/:  node tools/moodle-attendance-plan.js
require("dotenv").config();
const prisma = require("../src/db");
const { withoutAcademicScope } = require("../src/academicScope");

const URL = (process.env.MOODLE_URL || "").replace(/\/$/, "");
const TOKEN = process.env.MOODLE_TOKEN;

async function call(wsfunction, params = {}) {
  const body = new URLSearchParams({ wstoken: TOKEN, moodlewsrestformat: "json", wsfunction });
  for (const [k, v] of Object.entries(params)) body.append(k, v);
  const r = await fetch(`${URL}/webservice/rest/server.php`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  return r.json();
}

// Session descriptions are the unit's initials. Matching on initials rather than a
// hard-coded table means a new unit needs no code change.
const initials = (name) =>
  String(name).replace(/\(.*?\)/g, " ").split(/[\s\-/]+/)
    .filter((w) => /^[A-Za-z]/.test(w) && !/^(of|and|the|a|in|for|to)$/i.test(w))
    .map((w) => w[0].toUpperCase()).join("");

const NON_UNIT = /^(tutorial|workshop|regular class session|english|conflict|induction|revision|exam)/i;

// AN OPERATOR CLI HAS NO CALLER AND THEREFORE NO DEPARTMENT.
//
// It is run from a shell by somebody with database access, over the whole institution by
// definition. Without this declaration the academic scope guard throws on its first query
// against Student, Course, Enrolment or AttendanceMark -- which is what happened to all
// seven tools in this directory when the guard went live, because prisma/seed.js was
// wrapped and these were forgotten.
withoutAcademicScope("moodle attendance plan: an operator CLI covering every course", async () => {
  const courses = await call("core_course_get_courses");
  const acts = [];
  for (const c of courses) {
    if (!c.id) continue;
    const contents = await call("core_course_get_contents", { courseid: c.id });
    for (const sec of contents || []) for (const m of sec.modules || [])
      if (m.modname === "attendance") acts.push({ course: c.fullname, moodleCourseId: c.id, instance: m.instance ?? m.id });
  }

  const ourCourses = await prisma.course.findMany({ include: { units: true } });
  const students = await prisma.student.findMany({ select: { id: true, moodleUserId: true } });
  const byMoodleId = new Map(students.filter((s) => s.moodleUserId != null).map((s) => [s.moodleUserId, s]));
  console.log(`Students in Staff Hub: ${students.length}, of which ${byMoodleId.size} are already linked to a Moodle user\n`);

  let gTotal = 0, gMapped = 0, gUnmapped = 0, gMarks = 0, gMarksMapped = 0, gUnknownStudent = 0;

  for (const a of acts) {
    const sessions = await call("mod_attendance_get_sessions", { attendanceid: a.instance });
    if (!Array.isArray(sessions)) continue;

    // Match the Moodle course to one of ours by moodleCourseId, else by name.
    const ours = ourCourses.find((c) => c.moodleCourseId === a.moodleCourseId)
      || ourCourses.find((c) => c.name.trim().toLowerCase() === a.course.trim().toLowerCase());

    console.log("=".repeat(74));
    console.log(a.course);
    console.log("  matched to a Staff Hub course:", ours ? `yes — "${ours.name}" (${ours.units.length} units)` : "NO");
    if (!ours) { console.log("  -> nothing can be imported until this course is linked\n"); continue; }

    const unitByInitials = new Map();
    for (const u of ours.units) unitByInitials.set(initials(u.name), u);

    let mapped = 0, unmapped = 0, marks = 0, marksMapped = 0, unknownStudent = 0;
    const missReasons = new Map();

    for (const s of sessions) {
      const desc = String(s.description || "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim();
      const log = s.attendance_log || [];
      if (!log.length) continue;               // nothing recorded — nothing to import
      const unit = unitByInitials.get(desc.toUpperCase());
      if (unit) mapped++; else { unmapped++; missReasons.set(desc || "(blank)", (missReasons.get(desc || "(blank)") || 0) + 1); }
      for (const l of log) {
        marks++;
        if (!byMoodleId.has(Number(l.studentid))) unknownStudent++;
        else if (unit) marksMapped++;
      }
    }

    console.log(`  sessions carrying marks: ${mapped + unmapped}`);
    console.log(`    -> map to a unit:      ${mapped}`);
    console.log(`    -> do NOT map:         ${unmapped}`);
    if (missReasons.size) {
      console.log("       unmatched descriptions:");
      [...missReasons.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8)
        .forEach(([d, n]) => console.log(`         ${String(n).padStart(4)} x  ${JSON.stringify(d)}${NON_UNIT.test(d) ? "   (not a unit — tutorial/workshop)" : "   <- looks like a unit, check"}`));
    }
    console.log(`  individual marks: ${marks} | importable: ${marksMapped} | student not linked: ${unknownStudent}\n`);

    gTotal += sessions.length; gMapped += mapped; gUnmapped += unmapped;
    gMarks += marks; gMarksMapped += marksMapped; gUnknownStudent += unknownStudent;
  }

  console.log("=".repeat(74));
  console.log("TOTAL");
  console.log(`  sessions in Moodle:            ${gTotal}`);
  console.log(`  sessions with marks, mappable: ${gMapped}`);
  console.log(`  sessions with marks, NOT:      ${gUnmapped}`);
  console.log(`  attendance marks total:        ${gMarks}`);
  console.log(`  -> importable today:           ${gMarksMapped}`);
  console.log(`  -> student not linked:         ${gUnknownStudent}`);
  console.log(`\n  Staff Hub currently holds ${await prisma.attendanceMark.count()} attendance marks across ${await prisma.hndSession.count()} sessions.`);
  console.log("\nNothing was changed.");
  await prisma.$disconnect();
});
