// Demo data for the Scheduling screens — every field on every tab filled in.
//
// WHY EVERY ROW IS PREFIXED, AND WHY THAT IS THE WHOLE SAFETY DESIGN
//
// This exists to be run against a database that already holds a real college. The
// screens it fills — schools, campuses, rooms, categories, groups, classes — sit beside
// genuine records, and demo rows that cannot be told from real ones are demo rows nobody
// dares delete afterwards. So every single row this writes carries DEMO_PREFIX in a
// human-visible field, `--remove` deletes exactly and only those rows, and the two are
// written next to each other so they cannot drift apart.
//
// It writes NO students and NO staff. Both are identity: a fake student acquires an
// attendance record, a prediction score and a place in a cohort's denominators, and a
// fake staff account is a login. Neither is worth manufacturing to demonstrate a
// calendar, and the register screens read honestly with an empty roster — "no students in
// this group yet" is a true sentence about a demo group.
//
//   node tools/seed-demo-timetable.js                 # dry run, writes nothing
//   node tools/seed-demo-timetable.js --apply         # create
//   node tools/seed-demo-timetable.js --remove        # dry run of the removal
//   node tools/seed-demo-timetable.js --remove --apply
//
// ALWAYS pass DATABASE_URL explicitly. server/.env points at a live database.
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const REMOVE = process.argv.includes("--remove");
const P = "DEMO";

const log = (...a) => console.log(...a);
const would = (what) => log(`${APPLY ? "  ✓" : "  would"} ${what}`);

/** Monday of the week containing `d`, in UTC. Dates are strings everywhere here. */
function mondayOf(d) {
  const x = new Date(`${d}T00:00:00Z`);
  const iso = x.getUTCDay() === 0 ? 7 : x.getUTCDay();
  x.setUTCDate(x.getUTCDate() - (iso - 1));
  return x.toISOString().slice(0, 10);
}
const addDays = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

const SCHOOLS = [
  { key: `${P.toLowerCase()}-computing`, name: `${P} School of Computing`, colour: "#1a3a8f" },
  { key: `${P.toLowerCase()}-business`, name: `${P} School of Business`, colour: "#0f766e" },
  { key: `${P.toLowerCase()}-law`, name: `${P} School of Law`, colour: "#9e1b32" },
];
const CAMPUSES = [`${P} Harrow`, `${P} Ealing`];
const CATEGORIES = [
  { name: `${P} Lecture`, colour: "#1a3a8f" },
  { name: `${P} Seminar`, colour: "#0f766e" },
  { name: `${P} Lab`, colour: "#b45309" },
];

async function seed() {
  log(APPLY ? "Writing demo data.\n" : "DRY RUN — nothing will be written. Add --apply to commit.\n");

  log("Schools");
  const schools = {};
  for (const s of SCHOOLS) {
    const found = await prisma.academicDepartment.findFirst({ where: { name: s.name } });
    if (found) { schools[s.name] = found; log(`  · ${s.name} (already there)`); continue; }
    would(`school ${s.name}`);
    if (APPLY) schools[s.name] = await prisma.academicDepartment.create({ data: s });
  }

  log("\nCampuses and rooms");
  const campuses = {};
  for (const name of CAMPUSES) {
    const found = await prisma.campus.findFirst({ where: { name } });
    if (found) { campuses[name] = found; log(`  · ${name} (already there)`); continue; }
    would(`campus ${name}`);
    if (APPLY) campuses[name] = await prisma.campus.create({ data: { name } });
  }
  // Two rooms per campus, and deliberately the SAME NUMBER on both — that is the case
  // @@unique([name, campusId]) exists for, and a demo that never exercises it teaches the
  // reader that room numbers are globally unique.
  const rooms = [];
  for (const cName of CAMPUSES) {
    for (const [n, floor, kind, seats] of [["101", "First floor", "Lecture", 60], ["204", "Second floor", "Lab", 24]]) {
      const name = `${P} ${n}`;
      const campusId = campuses[cName]?.id ?? null;
      const found = campusId ? await prisma.room.findFirst({ where: { name, campusId } }) : null;
      if (found) { rooms.push(found); log(`  · room ${name} [${cName}] (already there)`); continue; }
      would(`room ${name} — ${floor} [${cName}], ${kind}, ${seats} seats`);
      if (APPLY) rooms.push(await prisma.room.create({ data: { name, floor, kind, capacity: seats, campusId, campus: cName } }));
    }
  }

  log("\nCategories");
  const cats = [];
  for (const c of CATEGORIES) {
    const found = await prisma.eventCategory.findFirst({ where: { name: c.name } });
    if (found) { cats.push(found); log(`  · ${c.name} (already there)`); continue; }
    would(`category ${c.name}`);
    if (APPLY) cats.push(await prisma.eventCategory.create({ data: c }));
  }

  log("\nCourses, modules and groups");
  const plan = [
    { school: `${P} School of Computing`, course: `${P} BSc Software Engineering`, units: ["Programming", "Databases", "Networks"], groups: ["SEP 25", "JAN 26"] },
    { school: `${P} School of Business`, course: `${P} HND Business`, units: ["Marketing", "Operations"], groups: ["SEP 25"] },
    { school: `${P} School of Law`, course: `${P} LLB Law`, units: ["Contract Law"], groups: ["SEP 25"] },
  ];
  const madeUnits = [];
  const madeGroups = [];
  for (const row of plan) {
    const deptId = schools[row.school]?.id ?? null;
    let course = await prisma.course.findFirst({ where: { name: row.course } });
    if (!course) {
      would(`course ${row.course} in ${row.school}`);
      if (APPLY) course = await prisma.course.create({ data: { name: row.course, academicDepartmentId: deptId } });
    } else log(`  · course ${row.course} (already there)`);
    if (!course) continue;

    for (const u of row.units) {
      const code = `${P}-${u.slice(0, 3).toUpperCase()}`;
      let unit = await prisma.unit.findFirst({ where: { courseId: course.id, code } });
      if (!unit) {
        would(`module ${code} — ${u}`);
        if (APPLY) unit = await prisma.unit.create({ data: { code, name: `${P} ${u}`, courseId: course.id, academicDepartmentId: deptId } });
      }
      if (unit) madeUnits.push({ unit, course, deptId });
    }
    for (const g of row.groups) {
      const name = `${P} ${g}`;
      let cohort = await prisma.cohort.findFirst({ where: { courseId: course.id, name } });
      if (!cohort) {
        would(`group ${name} on ${row.course}`);
        if (APPLY) cohort = await prisma.cohort.create({ data: { name, courseId: course.id, academicDepartmentId: deptId } });
      } else log(`  · group ${name} (already there)`);
      if (cohort) madeGroups.push({ cohort, course, deptId });
    }
  }

  log("\nClasses");
  // Anchored on THIS week's Monday so the demo is always on screen when the calendar
  // opens. A fixed date would be right for a day and then permanently off-screen.
  const monday = mondayOf(new Date().toISOString().slice(0, 10));
  let made = 0;
  if (APPLY && madeUnits.length) {
    const seriesPlan = [
      // [unit index, group index, weekday offset, sessions, room index, category index]
      [0, 0, 0, [["09:00", "12:00"], ["13:00", "16:00"]], 0, 0],   // Mon, two sessions
      [1, 0, 2, [["09:00", "11:00"]], 1, 2],                        // Wed, one
      [3, 2, 1, [["10:00", "13:00"]], 2, 1],                        // Tue, other school
      [5, 3, 3, [["14:00", "17:00"]], 3, 0],                        // Thu, third school
    ];
    // The first active real staff account, if the college has one. Read once, not per
    // event, and null is handled: a brand-new install has nobody, and the demo should
    // still produce a calendar rather than refusing.
    const teacher = await prisma.staff.findFirst({ orderBy: { name: "asc" }, select: { id: true, name: true } });
    if (teacher) log(`  · classes will be taught by ${teacher.name} (a real account, so they appear on My Timetable)`);
    else log("  · no staff account found, so these classes will have no lecturer");

    const seriesId = `demo-${Date.now()}`;
    for (const [ui, gi, dayOffset, sessions, ri, ci] of seriesPlan) {
      const u = madeUnits[ui]; const g = madeGroups[gi];
      if (!u || !g) continue;
      for (let week = 0; week < 3; week++) {
        for (const [start, end] of sessions) {
          const date = addDays(monday, dayOffset + week * 7);
          const exists = await prisma.timetableEvent.findFirst({ where: { date, startTime: start, title: { startsWith: P } , unitId: u.unit.id } });
          if (exists) continue;
          const ev = await prisma.timetableEvent.create({
            data: {
              date, startTime: start, endTime: end,
              title: `${P} ${u.unit.name.replace(P + " ", "")}`,
              unitId: u.unit.id, courseId: u.course.id,
              roomId: rooms[ri]?.id ?? null, categoryId: cats[ci]?.id ?? null,
              academicDepartmentId: u.deptId, published: true, publishedAt: new Date(),
              seriesId, createRegisters: true,
            },
          });
          await prisma.timetableEventGroup.create({ data: { eventId: ev.id, cohortId: g.cohort.id } });

          // TEACHING STAFF ARE BORROWED, NEVER INVENTED.
          //
          // "My Timetable" shows a member of staff the classes THEY teach — it filters on
          // TimetableEventStaff. A demo with no lecturer on it is therefore invisible on
          // that screen for everybody, which is exactly the screen somebody wants to look
          // at. But manufacturing a lecturer would create a login, so these are attached
          // to REAL accounts that already exist: the demo appears on their timetable, and
          // removing it detaches them again without touching the account itself.
          if (teacher) await prisma.timetableEventStaff.create({ data: { eventId: ev.id, staffId: teacher.id } });
          made++;
        }
      }
    }
    log(`  ✓ ${made} class(es) across 4 series, from ${monday}`);
  } else if (!APPLY) {
    log("  would create ~24 published classes across 4 series, starting this Monday,");
    log("    including one day with TWO sessions and classes in all three schools");
  }

  log(`\n${APPLY ? "Done." : "Nothing was written."} Everything is prefixed "${P}" and`);
  log(`removable with:  node tools/seed-demo-timetable.js --remove --apply`);
}

async function remove() {
  log(APPLY ? `Removing every row prefixed "${P}".\n` : `DRY RUN — nothing will be deleted. Add --apply.\n`);
  const like = { startsWith: P };

  // ORDER MATTERS: children before parents, or a foreign key refuses the delete. Events
  // before units and cohorts; cohorts before courses.
  const steps = [
    ["classes", () => prisma.timetableEvent.deleteMany({ where: { title: like } })],
    ["groups", () => prisma.cohort.deleteMany({ where: { name: like } })],
    ["modules", () => prisma.unit.deleteMany({ where: { code: { startsWith: `${P}-` } } })],
    ["courses", () => prisma.course.deleteMany({ where: { name: like } })],
    ["categories", () => prisma.eventCategory.deleteMany({ where: { name: like } })],
    ["rooms", () => prisma.room.deleteMany({ where: { name: like } })],
    ["campuses", () => prisma.campus.deleteMany({ where: { name: like } })],
    ["schools", () => prisma.academicDepartment.deleteMany({ where: { name: like } })],
  ];
  for (const [label, run] of steps) {
    if (!APPLY) {
      // Counted rather than deleted, so a dry run reports the real blast radius.
      const model = label;
      log(`  would delete ${label}`);
      continue;
    }
    const r = await run();
    log(`  ✓ ${r.count} ${label}`);
  }
  log(`\n${APPLY ? "Removed." : "Nothing was deleted."}`);
}

(async () => {
  const url = process.env.DATABASE_URL || "";
  const host = url.replace(/^.*@/, "").split("/")[0] || "(unknown)";
  log(`Database: ${host}\n`);
  try {
    if (REMOVE) await remove();
    else await seed();
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
