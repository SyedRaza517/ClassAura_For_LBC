// One class, today, running now — so the whole chain can be tested end to end.
//
// It writes what a real class needs and nothing else: an event on today's date, a
// teaching-staff assignment, a group, a room, and the register that follows from them.
// Everything else on the screens under test — the roster, the percentage, the check-in
// window — is DERIVED from those, so seeding them directly would prove the seed works
// rather than that the product does.
//
// Times are set around NOW so the class is in progress: a check-in window that opened
// twenty minutes ago and closes in two hours. A class later today would test the
// "not yet open" path, which is not the one anybody is trying to see.
//
//   node tools/seed-test-class.js                 # dry run
//   node tools/seed-test-class.js --apply
//   node tools/seed-test-class.js --remove --apply
//
// ALWAYS pass DATABASE_URL explicitly. server/.env points at a live database.
const { PrismaClient } = require("@prisma/client");
const { runWithAcademicScope } = require("../src/academicScope");
const { syncEventRegisters } = require("../src/timetabling/registers");

const bare = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const REMOVE = process.argv.includes("--remove");
const TITLE_PREFIX = "TEST CLASS";
const TZ = process.env.APP_TIMEZONE || "Europe/London";

// The college's today and now, not the machine's. A seed that used the host clock would
// put the class on yesterday for anybody running this from another timezone.
const localDate = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const localTime = (offsetMinutes = 0) => {
  const d = new Date(Date.now() + offsetMinutes * 60000);
  return d.toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
};

(async () => {
  const url = process.env.DATABASE_URL || "";
  if (!url) { console.error("FAILED: DATABASE_URL is not set. Pass it explicitly."); process.exit(1); }
  console.log(`Database: ${url.replace(/^.*@/, "").split("/")[0]}`);
  console.log(APPLY ? "MODE: APPLY\n" : "MODE: dry run. Nothing will be written. Add --apply.\n");

  try {
    if (REMOVE) {
      const events = await bare.timetableEvent.findMany({ where: { title: { startsWith: TITLE_PREFIX } }, select: { id: true } });
      if (!events.length) { console.log("Nothing to remove."); return; }
      if (!APPLY) { console.log(`Would remove ${events.length} test class(es) and their registers.`); return; }
      const ids = events.map((e) => e.id);
      // Registers first: HndSession.timetableEventId is SetNull, so deleting the event
      // alone would leave them behind, unlinked and looking like real history.
      const regs = await bare.hndSession.deleteMany({ where: { timetableEventId: { in: ids } } });
      const evs = await bare.timetableEvent.deleteMany({ where: { id: { in: ids } } });
      console.log(`Removed ${evs.count} class(es) and ${regs.count} register(s).`);
      return;
    }

    const staff = await bare.staff.findFirst({ where: { name: { contains: "Raza", mode: "insensitive" } }, select: { id: true, name: true } });
    if (!staff) { console.error("FAILED: no staff account matching 'Raza'."); process.exit(1); }

    // The group with the most students, so the register is not an empty sheet — the
    // roster is the thing under test and an empty one demonstrates nothing.
    const cohorts = await bare.cohort.findMany({ select: { id: true, name: true, courseId: true, _count: { select: { students: true } } } });
    cohorts.sort((a, b) => b._count.students - a._count.students);
    const cohort = cohorts[0];
    if (!cohort || cohort._count.students === 0) { console.error("FAILED: no group with students in it."); process.exit(1); }

    // A module on that group's own course, so the class is not a nonsense pairing.
    const unit = await bare.unit.findFirst({ where: { courseId: cohort.courseId }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } })
      || await bare.unit.findFirst({ orderBy: { code: "asc" }, select: { id: true, code: true, name: true } });
    if (!unit) { console.error("FAILED: no unit to teach."); process.exit(1); }

    const room = await bare.room.findFirst({ where: { active: true }, select: { id: true, name: true } });
    const date = localDate();
    const start = localTime(-20);
    const end = localTime(120);

    console.log(`  lecturer  ${staff.name}`);
    console.log(`  group     ${cohort.name}  (${cohort._count.students} students)`);
    console.log(`  module    ${unit.code} — ${unit.name}`);
    console.log(`  room      ${room?.name || "(none)"}`);
    console.log(`  when      ${date}  ${start}–${end}  (running now)`);

    // --term: A TERM OF CLASSES ACROSS THREE MODULES, which is what makes the timetable
    // screens worth looking at. One class proves the plumbing; three modules on three
    // weekdays at three times is the first arrangement that shows whether the SHAPE
    // works — whether colour separates modules, whether a constant room collapses into
    // the module header and drops its column, whether a day with nothing on reads as a
    // day with nothing on.
    // --today: ONE CLASS PER MODULE, ALL RUNNING NOW. `--term` spreads three modules
    // across three weekdays, which is what makes the timetable worth reading and means
    // only one of them is on any given day. To see the Check In screen with a choice on
    // it — three classes a student picks between and marks themselves present at — all
    // three have to be in progress at once, which no honest weekly timetable would be.
    // So it is its own flag rather than a change to --term.
    //
    // Windows are staggered and OVERLAPPING (started 30, 20 and 10 minutes ago), so all
    // three are inside their check-in window simultaneously while still being three
    // distinguishable classes rather than three copies of one.
    const wantToday = process.argv.includes("--today");
    const wantTerm = process.argv.includes("--term");
    const WEEKS = 6;
    const PLAN = [
      { dayOffset: 0, start: "09:00", end: "12:00" },   // Monday morning
      { dayOffset: 2, start: "13:00", end: "16:00" },   // Wednesday afternoon
      { dayOffset: 4, start: "10:00", end: "13:00" },   // Friday mid-morning
    ];
    if (wantToday) {
      const units = await bare.unit.findMany({
        where: { courseId: cohort.courseId }, orderBy: { code: "asc" }, take: 3,
        select: { id: true, code: true, name: true },
      });
      if (!units.length) { console.error("FAILED: no modules on that group's course."); process.exit(1); }
      const rooms = await bare.room.findMany({ where: { active: true }, orderBy: { name: "asc" }, take: 3, select: { id: true, name: true } });
      console.log(`
  TODAY: ${units.length} module(s), all running now`);
      const plan = units.map((u, i) => ({ u, room: rooms[i % rooms.length] || null, start: localTime(-30 + i * 10), end: localTime(90 + i * 10) }));
      for (const x of plan) console.log(`    ${x.u.code} - ${x.u.name}  |  ${x.start}-${x.end}  |  ${x.room?.name || "no room"}`);
      if (!APPLY) { console.log("\nWould create those. Add --apply."); return; }

      let made = 0, regs = 0;
      for (const x of plan) {
        const ev = await bare.timetableEvent.create({
          data: {
            title: `${TITLE_PREFIX} - ${x.u.name}`,
            date, startTime: x.start, endTime: x.end,
            unitId: x.u.id, courseId: cohort.courseId, roomId: x.room?.id ?? null,
            published: true, publishedAt: new Date(), createRegisters: true,
          },
        });
        await bare.timetableEventStaff.create({ data: { eventId: ev.id, staffId: staff.id } });
        await bare.timetableEventGroup.create({ data: { eventId: ev.id, cohortId: cohort.id } });
        const r = await runWithAcademicScope({ academicDepartmentIds: [], collegeWide: true }, () => syncEventRegisters(ev.id));
        made++; regs += r.created;
      }
      console.log(`
  OK ${made} class(es) running now, ${regs} register(s)`);
      console.log(`
Remove everything with:  node tools/seed-test-class.js --remove --apply`);
      return;
    }

    if (wantTerm) {
      const units = await bare.unit.findMany({
        where: { courseId: cohort.courseId }, orderBy: { code: "asc" }, take: 3,
        select: { id: true, code: true, name: true },
      });
      if (units.length < 2) { console.error(`FAILED: ${cohort.name}'s course has fewer than two modules to timetable.`); process.exit(1); }
      const rooms = await bare.room.findMany({ where: { active: true }, orderBy: { name: "asc" }, take: 3, select: { id: true, name: true } });

      // THIS week's Monday, so the term starts in the week the reader is already looking
      // at rather than somewhere they have to navigate to.
      const d0 = new Date(`${date}T00:00:00Z`);
      const isoDay = d0.getUTCDay() === 0 ? 7 : d0.getUTCDay();
      d0.setUTCDate(d0.getUTCDate() - (isoDay - 1));
      const monday = d0.toISOString().slice(0, 10);
      const plus = (n) => { const x = new Date(`${monday}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

      const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
      console.log(`\n  TERM: ${units.length} module(s) x ${WEEKS} weeks from ${monday}`);
      for (const [i, u] of units.entries()) {
        const slot = PLAN[i % PLAN.length];
        console.log(`    ${u.code} - ${u.name}  |  ${DAYS[slot.dayOffset]} ${slot.start}-${slot.end}  |  ${rooms[i % rooms.length]?.name || "no room"}`);
      }
      if (!APPLY) { console.log("\nWould create the class above AND that term. Add --apply."); return; }

      let made = 0, regs = 0;
      for (const [i, u] of units.entries()) {
        const slot = PLAN[i % PLAN.length];
        const room2 = rooms[i % rooms.length] || null;
        for (let w = 0; w < WEEKS; w++) {
          const when = plus(slot.dayOffset + w * 7);
          const ev = await bare.timetableEvent.create({
            data: {
              title: `${TITLE_PREFIX} - ${u.name}`,
              date: when, startTime: slot.start, endTime: slot.end,
              unitId: u.id, courseId: cohort.courseId, roomId: room2?.id ?? null,
              published: true, publishedAt: new Date(), createRegisters: true,
            },
          });
          await bare.timetableEventStaff.create({ data: { eventId: ev.id, staffId: staff.id } });
          await bare.timetableEventGroup.create({ data: { eventId: ev.id, cohortId: cohort.id } });
          const r = await runWithAcademicScope({ academicDepartmentIds: [], collegeWide: true }, () => syncEventRegisters(ev.id));
          made++; regs += r.created;
        }
      }
      console.log(`\n  OK ${made} class(es) across ${units.length} module(s), ${regs} register(s)`);
      console.log(`\nRemove everything with:  node tools/seed-test-class.js --remove --apply`);
      return;
    }
    if (!APPLY) { console.log("\nWould create that class, published, with its register."); return; }

    const event = await bare.timetableEvent.create({
      data: {
        title: `${TITLE_PREFIX} — ${unit.name}`,
        date, startTime: start, endTime: end,
        unitId: unit.id, courseId: cohort.courseId, roomId: room?.id ?? null,
        published: true, publishedAt: new Date(), createRegisters: true,
      },
    });
    await bare.timetableEventStaff.create({ data: { eventId: event.id, staffId: staff.id } });
    await bare.timetableEventGroup.create({ data: { eventId: event.id, cohortId: cohort.id } });

    // The register is BUILT BY THE PRODUCT, not written here. syncEventRegisters is what
    // the save path calls, so this exercises the same roster rule the screens read.
    // College-wide scope: a bare script has no request to take one from, and a narrower
    // one would silently skip the very event it just created.
    const out = await runWithAcademicScope({ academicDepartmentIds: [], collegeWide: true }, () => syncEventRegisters(event.id));
    console.log(`\n  ✓ class created`);
    console.log(`  ✓ registers: created ${out.created}, skipped ${out.skipped.map((s) => s.reason).join("; ") || "none"}`);
    const reg = await bare.hndSession.findFirst({ where: { timetableEventId: event.id }, select: { id: true, cohortId: true, audience: true } });
    console.log(`  ✓ register ${reg?.id} — ${reg?.audience}`);
    console.log(`\nRemove it with:  node tools/seed-test-class.js --remove --apply`);
  } finally {
    await bare.$disconnect();
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
