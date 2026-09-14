// One class, today, that named people can actually check into — for testing check-in
// against a real deployment without waiting for the timetable to run a real lesson.
//
// It creates (or reuses) a single clearly-named test module with NO GROUP, enrols the
// people named on it, and drops ONE session onto today at a time you choose. An
// ungrouped register's roster IS its enrolment list (rosterForSession, registers.js),
// so everyone enrolled here appears on the register and can check in, and nobody who
// is not enrolled is touched.
//
// EVERYTHING CARRIES THE TEST PREFIX so `--remove` is exact rather than a judgement
// call: the module (code ZZT-PM) and the session are deleted precisely, and the
// students are LEFT ALONE — removing a class never deletes a person.
//
//   node tools/seed-class-today.js                      # dry run — prints, writes nothing
//   node tools/seed-class-today.js --apply              # today 16:30-18:30, ZZ TEST student
//   node tools/seed-class-today.js --apply --for a@b.c  # also enrol an existing student
//   node tools/seed-class-today.js --apply --tutor me@college.ac.uk  # name the lecturer
//   node tools/seed-class-today.js --apply --start 16:30 --end 18:30
//   node tools/seed-class-today.js --remove --apply     # take the class + module away
//
// ALWAYS pass DATABASE_URL explicitly — server/.env points at a LIVE database, and a
// test class belongs on whichever one the app you are testing actually reads.
//
//   DATABASE_URL="postgres://…" node tools/seed-class-today.js --apply
const { PrismaClient } = require("@prisma/client");
const { localDate, localTime } = require("../src/clock");

const db = new PrismaClient();

const arg = (flag, dflt = null) => { const i = process.argv.indexOf(flag); return i > -1 ? (process.argv[i + 1] || dflt) : dflt; };
const APPLY = process.argv.includes("--apply");
const REMOVE = process.argv.includes("--remove");
const FOR_EMAIL = (arg("--for") || "").trim().toLowerCase() || null;
// The LECTURER of the test class, by staff email. Setting Unit.tutorStaffId is what
// makes the class theirs everywhere identity gates it: My Day, My Classes, the live
// register, announcements, conduct. Without this the class belonged to nobody and
// testing the lecturer half meant a hand-written UPDATE afterwards, every time.
const TUTOR_EMAIL = (arg("--tutor") || "").trim().toLowerCase() || null;
const START = (arg("--start", "16:30")).trim();
const END = (arg("--end", "18:30")).trim();

// The module every session created here hangs off. No course, no cohort — a null
// cohortId is what makes the roster the enrolment list, and a null courseId is allowed
// (Unit.courseId is nullable). Name and code are overridable so the class can read as a
// real subject; both default to Machine Learning. The code is the handle `--remove`
// deletes by, so a distinctive one keeps cleanup exact.
const UNIT_CODE = (arg("--code", "ML-TEST")).trim();
const UNIT_NAME = (arg("--name", "Machine Learning")).trim();

// The built-in test student (tools/seed-test-student.js). Reused if present so the two
// tools describe the same account; created here only if missing AND a password is given.
const TEST_REF = "ZZTEST001";

const isTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ""));

async function main() {
  console.log(APPLY ? "MODE: APPLY — writing.\n" : "MODE: dry run. Nothing will be written. Add --apply.\n");
  if (!isTime(START) || !isTime(END) || END <= START) {
    console.error(`FAILED: --start/--end must be HH:MM with end after start (got ${START}–${END}).`);
    process.exitCode = 1; return;
  }
  const date = localDate();

  if (REMOVE) {
    const unit = await db.unit.findFirst({ where: { code: UNIT_CODE } });
    if (!unit) { console.log("Nothing to remove — the test module does not exist."); return; }
    const sessions = await db.hndSession.count({ where: { unitId: unit.id } });
    const enrols = await db.enrolment.count({ where: { unitId: unit.id } });
    console.log(`Would remove module ${UNIT_CODE}: ${sessions} session(s), ${enrols} enrolment(s), and the module. Students are left untouched.`);
    if (!APPLY) { console.log("\nAdd --apply to remove."); return; }
    // Marks cascade with their session; enrolments and sessions are deleted explicitly,
    // then the unit. No student, course or cohort is touched.
    await db.attendanceMark.deleteMany({ where: { session: { unitId: unit.id } } });
    await db.hndSession.deleteMany({ where: { unitId: unit.id } });
    await db.enrolment.deleteMany({ where: { unitId: unit.id } });
    await db.unit.delete({ where: { id: unit.id } });
    console.log("Removed.");
    return;
  }

  // --- who is on the class ---------------------------------------------------------
  const roster = []; // { id, label }

  // The ZZ TEST student.
  let testStudent = await db.student.findFirst({ where: { studentRef: TEST_REF } });
  if (!testStudent) {
    const pw = process.env.TEST_STUDENT_PASSWORD;
    if (!pw || pw.length < 10) {
      console.error(`FAILED: no student has ref ${TEST_REF}, and creating one needs TEST_STUDENT_PASSWORD (10+ chars).\n` +
        `Either run tools/seed-test-student.js first, or set TEST_STUDENT_PASSWORD and re-run.`);
      process.exitCode = 1; return;
    }
    const bcrypt = require("bcryptjs");
    console.log(`${APPLY ? "Creating" : "Would create"} the test student ${TEST_REF} (test.student@edtech.co.uk).`);
    if (APPLY) {
      testStudent = await db.student.create({ data: {
        firstName: "ZZ", lastName: "TEST", studentRef: TEST_REF, email: "test.student@edtech.co.uk",
        initials: "ZT", colour: "#1a73e8", passwordHash: bcrypt.hashSync(pw, 10),
      } });
    }
  }
  if (testStudent) roster.push({ id: testStudent.id, label: `${TEST_REF} (${testStudent.email})` });

  // An existing student named by --for. NEVER created here and NEVER edited — if the
  // email is not a student on this database, say so and carry on with the rest.
  if (FOR_EMAIL) {
    const s = await db.student.findFirst({ where: { email: { equals: FOR_EMAIL, mode: "insensitive" } } });
    if (!s) {
      console.log(`NOTE: ${FOR_EMAIL} is not a STUDENT account on this database — not enrolled.\n` +
        `      (If it is a staff/admin login it cannot use the student check-in app. Use a student account,\n` +
        `       or create a test one with tools/seed-test-student.js.)`);
    } else {
      roster.push({ id: s.id, label: `${s.email} (${s.firstName} ${s.lastName})` });
    }
  }

  if (!roster.length) {
    console.error("FAILED: nobody to enrol — no test student and no valid --for student.");
    process.exitCode = 1; return;
  }

  // --- the lecturer ----------------------------------------------------------------
  // Resolved BEFORE the module is written, so a typo'd email fails the run rather
  // than leaving a tutor-less class and a message nobody reads. A STAFF account,
  // matched case-insensitively; refusing rather than skipping, because a test of
  // "what does the lecturer see" against a class with no lecturer proves nothing.
  let tutorStaff = null;
  if (TUTOR_EMAIL) {
    tutorStaff = await db.staff.findFirst({ where: { email: { equals: TUTOR_EMAIL, mode: "insensitive" } } });
    if (!tutorStaff) {
      console.error(`FAILED: ${TUTOR_EMAIL} is not a STAFF account on this database — no lecturer assigned, nothing written.`);
      process.exitCode = 1; return;
    }
    console.log(`Lecturer: ${tutorStaff.name} (${tutorStaff.email}).`);
  }

  // --- the module ------------------------------------------------------------------
  let unit = await db.unit.findFirst({ where: { code: UNIT_CODE } });
  console.log(unit ? `Using existing module ${UNIT_CODE}.` : `${APPLY ? "Creating" : "Would create"} module ${UNIT_CODE} "${UNIT_NAME}" (no group, no course).`);
  if (APPLY && !unit) {
    unit = await db.unit.create({ data: { code: UNIT_CODE, name: UNIT_NAME, unitNumber: "", tutor: "" } });
  }
  // Set (or move) the tutor on a reused module too — re-running with a different
  // --tutor is how the class is handed to somebody else between tests.
  if (APPLY && unit && tutorStaff && unit.tutorStaffId !== tutorStaff.id) {
    unit = await db.unit.update({ where: { id: unit.id }, data: { tutorStaffId: tutorStaff.id } });
    console.log(`Module ${UNIT_CODE} now tutored by ${tutorStaff.name}.`);
  }

  // --- enrolments (idempotent) -----------------------------------------------------
  console.log(`${APPLY ? "Enrolling" : "Would enrol"} ${roster.length} student(s): ${roster.map((r) => r.label).join(", ")}.`);
  if (APPLY) {
    await db.enrolment.createMany({ data: roster.map((r) => ({ studentId: r.id, unitId: unit.id })), skipDuplicates: true });
  }

  // --- the session (today, the chosen window, ungrouped) ---------------------------
  let session = APPLY ? await db.hndSession.findFirst({ where: { unitId: unit?.id, date, startTime: START, cohortId: null } }) : null;
  if (session) {
    console.log(`A session already exists today ${date} ${START}–${END} — reused, nothing duplicated.`);
  } else {
    console.log(`${APPLY ? "Creating" : "Would create"} a session today ${date} ${START}–${END} on ${UNIT_CODE}.`);
    if (APPLY) {
      session = await db.hndSession.create({ data: {
        unitId: unit.id, date, startTime: START, endTime: END,
        description: "Check-in test class", kind: "Teaching",
      } });
    }
  }

  const nowT = localTime();
  const running = nowT >= START && nowT <= END;
  console.log(`\n${APPLY ? "Done." : "Dry run complete — add --apply to write."}`);
  console.log(`Class: ${date} ${START}–${END}${running ? "  (RUNNING NOW — check-in is open)" : `  (opens ${START}; it is ${nowT} now)`}`);
  console.log(`On the register: ${roster.map((r) => r.label).join(", ")}`);
  console.log(`Undo later with:  DATABASE_URL="…" node tools/seed-class-today.js --remove --apply`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exitCode = 1; }).finally(() => db.$disconnect());
