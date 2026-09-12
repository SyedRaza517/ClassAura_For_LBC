// Move the ZZ TEST sessions onto TODAY, taught by a chosen lecturer.
//
// WHY THIS EXISTS. seed-test-student.js lays a whole term of classes on ONE weekday
// (today's, at seed time), so on every other day of the week the test student has nothing
// running and Check In is correctly empty — useless for testing on, say, a Saturday. This
// takes the next future week's ZZ TEST sessions and slides them onto today at staggered
// times, so there is always a class over, one live now, and one this evening.
//
// RAW SQL ON PURPOSE. The codebase is mid-way through the Teams feature: the generated
// Prisma client expects teamsJoinUrl columns that production's database does not have yet
// (its migration is committed but undeployed). Any client read/write that returns a full
// row therefore throws P2022. $executeRawUnsafe names only the columns it touches and never
// references teamsJoinUrl, so it works against the older production schema untouched. When
// the Teams migration is deployed this script keeps working unchanged.
//
// Run from server/:
//   $env:DATABASE_URL="<production url>"; node tools/move-test-sessions-to-today.mjs
//   (add LECTURER_EMAIL=someone@college to teach them as somebody other than Syed Raza)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

const LECTURER_EMAIL = (process.env.LECTURER_EMAIL || "syedmuhammadr517@gmail.com").toLowerCase();
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

// One slot per module. Between them the day is covered 08:00–22:00, so whenever the tester
// opens the app something is either running or clearly finished/upcoming — every state the
// Check In screen has.
const SLOTS = {
  ZZT101: { start: "08:00", end: "11:30" }, // finished by mid-morning
  ZZT102: { start: "11:00", end: "17:00" }, // the one running through the afternoon
  ZZT103: { start: "17:00", end: "22:00" }, // the evening class
};

const staff = await p.$queryRawUnsafe(`select id, name from "Staff" where lower(email)=$1`, LECTURER_EMAIL);
if (!staff.length) { console.error(`FAILED: no staff with email ${LECTURER_EMAIL}`); process.exit(1); }
const lecturerId = staff[0].id;
console.log(`lecturer: ${staff[0].name}  |  today: ${today}`);

const already = await p.$queryRawUnsafe(
  `select count(*)::int n from "HndSession" s join "Unit" u on u.id=s."unitId" where u.code like 'ZZT%' and s.date=$1`, today);
if (already[0].n > 0) {
  console.log(`Today already has ${already[0].n} ZZ TEST session(s). Nothing to move — you're set.`);
  await p.$disconnect(); process.exit(0);
}

// Earliest FUTURE session per unit — safe to move (no marks yet, nothing historical touched).
const rows = await p.$queryRawUnsafe(`
  select distinct on (u.code) s.id sid, s."timetableEventId" eid, u.code
  from "HndSession" s join "Unit" u on u.id=s."unitId"
  where u.code like 'ZZT%' and s.date > $1
  order by u.code, s.date asc`, today);
if (!rows.length) { console.error("FAILED: no future ZZ TEST sessions to move. Run seed-test-student.js --apply first."); process.exit(1); }

let moved = 0;
for (const r of rows) {
  const slot = SLOTS[r.code];
  if (!slot) continue;
  await p.$executeRawUnsafe(`UPDATE "HndSession"      SET date=$1, "startTime"=$2, "endTime"=$3 WHERE id=$4`, today, slot.start, slot.end, r.sid);
  await p.$executeRawUnsafe(`UPDATE "TimetableEvent"  SET date=$1, "startTime"=$2, "endTime"=$3 WHERE id=$4`, today, slot.start, slot.end, r.eid);
  await p.$executeRawUnsafe(`UPDATE "TimetableEventStaff" SET "staffId"=$1 WHERE "eventId"=$2`, lecturerId, r.eid);
  console.log(`  ${r.code} → ${today} ${slot.start}-${slot.end}, taught by ${staff[0].name}`);
  moved += 1;
}
console.log(`\nDone: ${moved} session(s) now on today. Sign in as test.student to scan, or as ${staff[0].name} to display the code.`);
await p.$disconnect();
