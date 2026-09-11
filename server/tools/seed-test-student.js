// One student who can sign in, with three classes running right now — so every check-in
// method can be tried end to end against a real deployment.
//
// WHY THIS CREATES ITS OWN STUDENT INSTEAD OF REUSING ONE.
//
// The obvious shortcut is to set a password on an existing student and hand that over.
// Against a live college database that is not a test fixture — it is a person, and giving
// their account a new password locks them out of their own record with no warning and no
// way for them to know why. A dedicated account, named so nobody mistakes it for real,
// costs one row and takes that entire class of accident off the table.
//
// It also gets its OWN GROUP, for the same reason in the other direction: attaching a fake
// student to a real cohort would put them on that cohort's registers, in its attendance
// figures and in whatever a lecturer exports for it. The test group holds exactly one
// student and is scheduled against nothing but the classes created here.
//
// EVERYTHING IS NAMED, so removal is exact rather than a judgement call afterwards: the
// group, the modules and the events all carry TEST_PREFIX, and --remove deletes precisely
// those and nothing else.
//
//   node tools/seed-test-student.js                 # dry run — prints what it would do
//   node tools/seed-test-student.js --apply
//   node tools/seed-test-student.js --remove --apply
//
// ALWAYS pass DATABASE_URL explicitly. server/.env points at a live database, and this
// tool is meant to be run against live databases, so there is no version of "it will be
// fine" here — the URL you pass is the college you are writing to.
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const { runWithAcademicScope } = require("../src/academicScope");
const { syncEventRegisters } = require("../src/timetabling/registers");

const bare = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const REMOVE = process.argv.includes("--remove");

const TEST_PREFIX = "ZZ TEST";
const STUDENT_EMAIL = "test.student@edtech.co.uk";
const STUDENT_REF = "ZZTEST001";
const TZ = process.env.APP_TIMEZONE || "Europe/London";

// Passed in so the same password can be set on two databases in one sitting, and so it is
// never a constant sitting in a file somebody later deploys.
const PASSWORD = process.env.TEST_STUDENT_PASSWORD;

// The college's today and now, never the host clock's. A seed that used the machine clock
// would put the classes on yesterday for anybody running this from another timezone, and
// the screen under test reads the college's day.
const localDate = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const localTime = (offsetMinutes = 0) =>
  new Date(Date.now() + offsetMinutes * 60000)
    .toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

(async () => {
  const url = process.env.DATABASE_URL || "";
  if (!url) { console.error("FAILED: DATABASE_URL is not set. Pass it explicitly."); process.exit(1); }
  console.log(`Database: ${url.replace(/^.*@/, "").split("/")[0]}`);
  console.log(APPLY ? "MODE: APPLY\n" : "MODE: dry run. Nothing will be written. Add --apply.\n");

  try {
    if (REMOVE) {
      const events = await bare.timetableEvent.findMany({ where: { title: { startsWith: TEST_PREFIX } }, select: { id: true } });
      const ids = events.map((e) => e.id);
      const student = await bare.student.findFirst({ where: { studentRef: STUDENT_REF }, select: { id: true } });
      const cohort = await bare.cohort.findFirst({ where: { name: { startsWith: TEST_PREFIX } }, select: { id: true } });
      const units = await bare.unit.findMany({ where: { name: { startsWith: TEST_PREFIX } }, select: { id: true } });
      console.log(`Found: ${ids.length} event(s), ${units.length} module(s), ${cohort ? 1 : 0} group, ${student ? 1 : 0} student`);
      if (!APPLY) { console.log("\nWould remove those. Add --apply."); return; }

      // ORDER MATTERS. HndSession.timetableEventId is SetNull, so deleting the events first
      // would leave their registers behind — unlinked, and looking exactly like real history
      // somebody took by hand. The marks go with the registers, which is right here and
      // ONLY here: these are marks made by a fabricated student on fabricated classes.
      const regs = await bare.hndSession.deleteMany({ where: { OR: [{ timetableEventId: { in: ids } }, { unitId: { in: units.map((u) => u.id) } }] } });
      const evs = await bare.timetableEvent.deleteMany({ where: { id: { in: ids } } });
      if (student) await bare.student.delete({ where: { id: student.id } }).catch((e) => console.error("  student:", e.message));
      await bare.unit.deleteMany({ where: { id: { in: units.map((u) => u.id) } } });
      if (cohort) await bare.cohort.delete({ where: { id: cohort.id } }).catch((e) => console.error("  group:", e.message));
      console.log(`Removed ${evs.count} class(es), ${regs.count} register(s), the modules, the group and the student.`);
      return;
    }

    if (!PASSWORD || PASSWORD.length < 10) {
      console.error("FAILED: set TEST_STUDENT_PASSWORD (at least 10 characters).");
      process.exit(1);
    }

    // A member of staff to teach them. Reused rather than invented: a fabricated staff
    // account would be a second fake identity to clean up, and it would appear in the
    // college's own staff lists where somebody might email it.
    // Staff has no `active` column — leavers are handled elsewhere — so this takes the
    // first by name rather than filtering on a field that does not exist.
    const staff = await bare.staff.findFirst({ orderBy: { name: "asc" }, select: { id: true, name: true } });
    if (!staff) { console.error("FAILED: this database has no active staff to teach the classes."); process.exit(1); }

    // A real course, so the modules are not orphaned — but NOT a real cohort.
    const course = await bare.course.findFirst({ orderBy: { name: "asc" }, select: { id: true, name: true, academicDepartmentId: true } });
    if (!course) { console.error("FAILED: this database has no courses."); process.exit(1); }

    const rooms = await bare.room.findMany({ where: { active: true }, orderBy: { name: "asc" }, take: 3, select: { id: true, name: true } });
    const date = localDate();

    // TWO SESSIONS, AT THE TIMES A REAL COLLEGE DAY RUNS: a morning block and an afternoon
    // one, exactly as asked for.
    //
    // This replaced three classes deliberately staggered to be in progress simultaneously,
    // which was useful for one thing only — seeing the Check In screen with a CHOICE on it —
    // and dishonest about everything else. No timetable looks like that, so every screen
    // reading it showed something no student would ever meet.
    //
    // The trade-off is worth stating because it changes how testing goes: at any given
    // moment only ONE of these is running, so Check In shows one card, not two. That is the
    // correct behaviour — a student is in one room at a time — and it means the second card
    // is tested by coming back after 14:00 rather than by looking twice in a minute.
    const PLAN = [
      { name: `${TEST_PREFIX} Computing Practice`, code: "ZZT101", start: "10:00", end: "13:00" },
      { name: `${TEST_PREFIX} Business Systems`, code: "ZZT102", start: "14:00", end: "17:00" },
    ];

    console.log(`  student   Test Student <${STUDENT_EMAIL}>  (ref ${STUDENT_REF})`);
    console.log(`  group     ${TEST_PREFIX} Group   — one student, scheduled against nothing else`);
    console.log(`  course    ${course.name}`);
    console.log(`  lecturer  ${staff.name}`);
    console.log(`  date      ${date}`);
    for (const [i, c] of PLAN.entries()) {
      console.log(`    ${c.code}  ${c.name}  |  ${c.start}–${c.end}  |  ${rooms[i % Math.max(1, rooms.length)]?.name || "no room"}`);
    }
    if (!APPLY) { console.log("\nWould create the above. Add --apply."); return; }

    // Upserted on its NAME rather than created, so running this twice does not leave two
    // test groups behind — the second run should adopt the first one's rows.
    let cohort = await bare.cohort.findFirst({ where: { name: `${TEST_PREFIX} Group` } });
    if (!cohort) {
      cohort = await bare.cohort.create({
        data: { name: `${TEST_PREFIX} Group`, courseId: course.id, academicDepartmentId: course.academicDepartmentId ?? null },
      });
    }

    const passwordHash = bcrypt.hashSync(PASSWORD, 10);
    let student = await bare.student.findFirst({ where: { studentRef: STUDENT_REF } });
    if (student) {
      // tokenVersion is bumped so any session left signed in on an old password is ended.
      student = await bare.student.update({
        where: { id: student.id },
        data: { passwordHash, cohortId: cohort.id, active: true, tokenVersion: { increment: 1 } },
      });
      console.log("\n  ✓ existing test student updated (password reset, sessions ended)");
    } else {
      student = await bare.student.create({
        data: {
          firstName: "Test", lastName: "Student", studentRef: STUDENT_REF, email: STUDENT_EMAIL,
          initials: "TS", colour: "#64748b", active: true, cohortId: cohort.id, passwordHash,
        },
      });
      console.log("\n  ✓ test student created");
    }

    let made = 0, registers = 0;
    for (const [i, c] of PLAN.entries()) {
      let unit = await bare.unit.findFirst({ where: { code: c.code } });
      if (!unit) {
        unit = await bare.unit.create({
          data: { code: c.code, name: c.name, courseId: course.id, startDate: date, endDate: date },
        });
      } else {
        // The module outlives the day, so its dates are widened to include today rather
        // than left on whenever it was first seeded — a class outside its module's dates
        // is refused by the term lock, which would look like the feature being broken.
        await bare.unit.update({ where: { id: unit.id }, data: { startDate: date, endDate: date } });
      }

      // NO ENROLMENT ROW, deliberately. The student reaches this register through their
      // GROUP, which is how every hand-created module in this product works — and it is
      // the path the roster fix of 11 Sep 2026 exists to protect. Testing the enrolment
      // path instead would test the easy half.
      const event = await bare.timetableEvent.create({
        data: {
          title: c.name, date, startTime: c.start, endTime: c.end,
          unitId: unit.id, courseId: course.id, roomId: rooms[i % Math.max(1, rooms.length)]?.id ?? null,
          published: true, publishedAt: new Date(), createRegisters: true,
        },
      });
      await bare.timetableEventStaff.create({ data: { eventId: event.id, staffId: staff.id } });
      await bare.timetableEventGroup.create({ data: { eventId: event.id, cohortId: cohort.id } });

      // The register is BUILT BY THE PRODUCT, not written here — syncEventRegisters is what
      // the save path itself calls, so this exercises the same roster rule the screens read
      // rather than proving the seed can insert a row. College-wide scope because a bare
      // script has no request to take one from, and a narrower one would silently skip the
      // very event it just created.
      const out = await runWithAcademicScope({ academicDepartmentIds: [], collegeWide: true }, () => syncEventRegisters(event.id));
      made += 1; registers += out.created;
      if (out.skipped?.length) console.log(`    ${c.code}: register skipped — ${out.skipped.map((s) => s.reason).join("; ")}`);
    }

    console.log(`  ✓ ${made} class(es) running now, ${registers} register(s) built by the product`);
    const roster = await bare.hndSession.findMany({
      where: { date, unit: { code: { startsWith: "ZZT" } } },
      select: { id: true, startTime: true, endTime: true, unit: { select: { code: true } } },
    });
    for (const r of roster) console.log(`    ${r.unit.code}  ${r.startTime}–${r.endTime}  register ${r.id}`);

    console.log(`\nSIGN IN AS:  ${STUDENT_EMAIL}`);
    console.log(`REMOVE WITH: node tools/seed-test-student.js --remove --apply`);
  } finally {
    await bare.$disconnect();
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
