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
const supportDepartments = require("../src/supportDepartments");

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
      // Assessments (and their grades, by cascade) go before the modules they hang off.
      // Named rather than left to the unit cascade: a cascade is a schema decision
      // somebody may change, and a seed tool that silently stops cleaning up is worse
      // than one that fails loudly.
      await bare.assessment.deleteMany({ where: { unitId: { in: units.map((u) => u.id) } } });
      await bare.unit.deleteMany({ where: { id: { in: units.map((u) => u.id) } } });
      if (cohort) await bare.cohort.delete({ where: { id: cohort.id } }).catch((e) => console.error("  group:", e.message));
      // The review, the questions and the referral are all Cascade from Student, so
      // deleting the student takes them — which is why the student delete happens above
      // and not last.
      console.log(`Removed ${evs.count} class(es), ${regs.count} register(s), the modules, the group, the student and everything hanging off them.`);
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
      // 13:00 rather than 14:00 so the afternoon class is live from one o'clock — there is
      // no gap in the middle of the day where neither session is running and the Check In
      // screen has nothing to act on.
      { name: `${TEST_PREFIX} Business Systems`, code: "ZZT102", start: "13:00", end: "17:00" },
    ];

    // A WHOLE TERM, not one day — because the timetable screen is a term of dates and a
    // single day tells you nothing about whether it works.
    //
    // Twelve weeks on the SAME WEEKDAY AS TODAY, four of them already behind. Both halves
    // of that are deliberate:
    //
    //   The weekday is today's, so today always carries both sessions. A term pinned to
    //   Mondays would leave Check In empty on every other day of the week, which is the
    //   one screen this account exists to exercise.
    //
    //   Four weeks in the past make the screen honest. A term that starts today shows
    //   "0 of 12 so far", every row identical and nothing marked — so the week counter,
    //   the past-class greying and the "Not marked" state are all invisible. With weeks
    //   behind it, the screen shows what a student meets in the middle of a term, which
    //   is when they actually open it.
    const WEEKS_BEFORE = 4;
    const WEEKS_AFTER = 7;
    const dayOffset = (n) => {
      const d = new Date(`${date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const TERM_DATES = [];
    for (let w = -WEEKS_BEFORE; w <= WEEKS_AFTER; w += 1) TERM_DATES.push(dayOffset(w * 7));

    console.log(`  student   Test Student <${STUDENT_EMAIL}>  (ref ${STUDENT_REF})`);
    console.log(`  group     ${TEST_PREFIX} Group   — one student, scheduled against nothing else`);
    console.log(`  course    ${course.name}`);
    console.log(`  lecturer  ${staff.name}`);
    console.log(`  term      ${TERM_DATES[0]} → ${TERM_DATES[TERM_DATES.length - 1]}  (${TERM_DATES.length} weeks, today is week ${WEEKS_BEFORE + 1})`);
    for (const [i, c] of PLAN.entries()) {
      console.log(`    ${c.code}  ${c.name}  |  ${c.start}–${c.end}  |  ${rooms[i % Math.max(1, rooms.length)]?.name || "no room"}  ×${TERM_DATES.length}`);
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
          data: { code: c.code, name: c.name, courseId: course.id, startDate: TERM_DATES[0], endDate: TERM_DATES[TERM_DATES.length - 1] },
        });
      } else {
        // The module outlives the day, so its dates are widened to include today rather
        // than left on whenever it was first seeded — a class outside its module's dates
        // is refused by the term lock, which would look like the feature being broken.
        await bare.unit.update({ where: { id: unit.id }, data: { startDate: TERM_DATES[0], endDate: TERM_DATES[TERM_DATES.length - 1] } });
      }

      // NO ENROLMENT ROW, deliberately. The student reaches this register through their
      // GROUP, which is how every hand-created module in this product works — and it is
      // the path the roster fix of 11 Sep 2026 exists to protect. Testing the enrolment
      // path instead would test the easy half.
      for (const when of TERM_DATES) {
        const event = await bare.timetableEvent.create({
          data: {
            title: c.name, date: when, startTime: c.start, endTime: c.end,
            unitId: unit.id, courseId: course.id, roomId: rooms[i % Math.max(1, rooms.length)]?.id ?? null,
            published: true, publishedAt: new Date(), createRegisters: true,
          },
        });
        await bare.timetableEventStaff.create({ data: { eventId: event.id, staffId: staff.id } });
        await bare.timetableEventGroup.create({ data: { eventId: event.id, cohortId: cohort.id } });

        // The register is BUILT BY THE PRODUCT, not written here — syncEventRegisters is
        // what the save path itself calls, so this exercises the same roster rule the
        // screens read rather than proving the seed can insert a row. College-wide scope
        // because a bare script has no request to take one from, and a narrower one would
        // silently skip the very event it just created.
        const out = await runWithAcademicScope({ academicDepartmentIds: [], collegeWide: true }, () => syncEventRegisters(event.id));
        made += 1; registers += out.created;
        if (out.skipped?.length) console.log(`    ${c.code} ${when}: register skipped — ${out.skipped.map((s) => s.reason).join("; ")}`);
      }
    }

    console.log(`  ✓ ${made} class(es) across the term, ${registers} register(s) built by the product`);

    /* ------------------------------------------------------------------ *
     * THE REST OF THE APP.
     *
     * A student account with only a timetable exercises one screen out of seven. Every
     * other tab renders its own empty state — which is a real state worth having seen
     * once, and useless for judging whether the screen works. So each gets enough data
     * to be looked at properly, and no more.
     *
     * DELIBERATELY A MIXED PICTURE rather than a tidy one. A student who is Present at
     * everything, passing everything and has no open conversations tests only the happy
     * half of each screen: the late chip, the absence, the failed assessment, the
     * unanswered question and the "At Risk" review are the states somebody actually has
     * to make a decision about, and a demo without them shows the easy screen.
     * ------------------------------------------------------------------ */

    // ATTENDANCE: marks against the classes that have already happened.
    //
    // Written onto the registers the product built above, not onto invented sessions, so
    // the attendance percentage, the module breakdown and the timetable's own "Not
    // marked" column are all reading the same rows the real app reads.
    //
    // One class is deliberately left UNMARKED. That is the difference between "absent"
    // and "nobody took the register", which this codebase treats as null rather than
    // zero everywhere — and the one case a screen can silently get wrong.
    const pastRegisters = await bare.hndSession.findMany({
      where: { date: { lt: date }, unit: { code: { startsWith: "ZZT" } } },
      orderBy: [{ date: "asc" }, { startTime: "asc" }],
      select: { id: true, date: true },
    });
    const PATTERN = ["P", "P", "L", "P", "A", "P", "P", "E"];
    let marked = 0;
    for (const [i, reg] of pastRegisters.entries()) {
      if (i === pastRegisters.length - 1) break;          // the last one: nobody took it
      const status = PATTERN[i % PATTERN.length];
      await bare.attendanceMark.create({
        data: {
          sessionId: reg.id, studentId: student.id, status, remark: "",
          takenBy: staff.name,
          // Only a mark that says they turned up carries an arrival time. An absence has
          // no arrival, and inventing one would make the row contradict itself.
          checkedInAt: status === "A" ? null : (status === "L" ? "10:22" : "10:03"),
        },
      }).catch(() => {});
      marked += 1;
    }

    // ASSESSMENTS: two per module, one marked and one still to come.
    //
    // The ungraded one matters more than the graded one. A results screen showing only
    // finished work never renders "not submitted yet" or a due date in the future, which
    // is most of what a student opens it to see.
    let assessments = 0, grades = 0;
    for (const [i, c] of PLAN.entries()) {
      const unit = await bare.unit.findFirst({ where: { code: c.code }, select: { id: true } });
      if (!unit) continue;
      const done = await bare.assessment.create({
        data: { unitId: unit.id, title: `${TEST_PREFIX} Coursework 1`, type: "Assignment", maxMarks: 100, weight: 40, dueDate: TERM_DATES[1] },
      });
      const upcoming = await bare.assessment.create({
        data: { unitId: unit.id, title: `${TEST_PREFIX} Coursework 2`, type: "Project", maxMarks: 100, weight: 60, dueDate: TERM_DATES[TERM_DATES.length - 2] },
      });
      assessments += 2;
      // A pass on one module and a near-miss on the other, so the screen has to render
      // both a comfortable result and one worth a conversation.
      await bare.assessmentGrade.create({
        data: {
          assessmentId: done.id, studentId: student.id, marks: i === 0 ? 72 : 38,
          gradedOn: TERM_DATES[2], gradedBy: staff.name,
          feedback: i === 0
            ? "Solid work — clear structure and good use of examples. Push the evaluation further next time."
            : "Below the pass mark. The analysis section needs more depth; see me about a resubmission.",
        },
      });
      grades += 1;
      void upcoming;
    }

    // A PASTORAL REVIEW, and deliberately not a reassuring one. "At Risk" with agreed
    // actions and a follow-up date is the shape a college reads these for; "On Track"
    // with nothing to do renders the same layout with none of the content.
    await bare.studentReview.create({
      data: {
        studentId: student.id, staffId: staff.id, staffName: staff.name,
        date: TERM_DATES[3], progress: "Monitor",
        concerns: JSON.stringify(["Attendance", "Assessment submission"]),
        summary: "Attendance has dipped since the start of term and one piece of coursework came in below the pass mark. Student reports travel difficulties on the days affected.",
        agreedActions: "Attend all sessions for the next four weeks. Resubmit Coursework 1 by the agreed date. Book a study-skills session.",
        followUp: true, followUpDate: TERM_DATES[TERM_DATES.length - 3],
      },
    });

    // TWO QUESTIONS: one answered, one still open. The open one is the state the screen
    // exists for — a student checking whether anybody has come back to them.
    await bare.studentQuery.create({
      data: {
        studentId: student.id, subject: "Timetable clash",
        message: "My two modules both show as running this afternoon. Which one should I go to?",
        status: "answered", response: "Thanks for flagging it — the afternoon session moved to 13:00 and the timetable is now correct. Go to Business Systems.",
        respondedBy: staff.name, respondedAt: TERM_DATES[3],
      },
    });
    await bare.studentQuery.create({
      data: {
        studentId: student.id, subject: "Resubmission deadline",
        message: "When is the latest I can resubmit Coursework 1?",
        status: "open",
      },
    });

    // A SUPPORT REFERRAL, open, so the support screen has a live case on it rather than
    // a closed one nobody needs to act on.
    // The department is a KEY from the support-departments config, not a table and not a
    // display name — the student's own referral route resolves the key the same way, and a
    // row carrying a pretty name would never match the staff screens' filter.
    const activeDepts = await supportDepartments.active().catch(() => []);
    const deptKey = activeDepts[0]?.key || null;
    if (!deptKey) {
      console.log("    (no support team is taking requests on this deployment — referral skipped)");
    } else {
      await bare.referral.create({
        data: {
          studentId: student.id,
          department: deptKey,
          reason: "Struggling to keep up after missing two weeks. Would like help planning the catch-up work.",
          urgency: "routine", status: "open", raisedOn: TERM_DATES[3],
          // studentNotified TRUE, exactly as the student's own referral route sets it.
          // The column records whether the referrer chose to tell the student, and the
          // student's list filters on it — so a referral seeded without it is invisible on
          // the screen it was seeded for, which is how this was first written and how the
          // rehearsal caught it. A referral somebody raises about THEMSELVES is, by
          // definition, one they know about.
          studentNotified: true,
          // raisedBy stays NULL, exactly as the student's own route leaves it: that column
          // means "which colleague raised this", and a self-referral carrying a name there
          // reads as staff-raised on every screen that shows it.
        },
      });
    }

    console.log(`  ✓ ${marked} attendance mark(s) on past classes, one register left untaken on purpose`);
    console.log(`  ✓ ${assessments} assessment(s), ${grades} graded — one pass, one below the mark`);
    console.log(`  ✓ 1 pastoral review, 2 questions (one answered, one open), 1 support referral`);
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
