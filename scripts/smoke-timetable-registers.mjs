// Timetable → registers: publishing a class builds its attendance registers.
//
// Weighted toward NEGATIVE assertions like the other suites. The one this file exists
// for is "a MARKED register is not moved by an event edit": the timetable is the source
// of truth right up to the moment a register becomes evidence, and then it stops. A
// design where editing a calendar entry rewrites taken attendance loses a dispute
// invisibly, because nothing afterwards records that the times were ever different.
//
// The second is "a merged class keeps SEPARATE registers". One module taught to two
// intakes at one time is two register groups, and a mark on one must not appear on the
// other. That is what HndSession_event_group_key permits and the old
// @@unique([unitId, date, startTime]) forbade.
//
// Prereq: API running (npm test boots one on 4010; npm run dev uses 4000)
// Usage:  DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node scripts/smoke-timetable-registers.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(pathToFileURL(join(ROOT, "server", "package.json")));
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — point it at a throwaway database."); process.exit(1); }
// A bare client, deliberately: it verifies what the API did, so it must not be the
// client the API wrote through.
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const BASE = process.env.API_URL || "http://localhost:4000/api";
const SEED_PW = process.env.SEED_PASSWORD || "password123";
const TAG = `tr${Date.now()}`;
let pass = 0, fail = 0;
const check = (l, ok, d = "") => { console.log(`${ok ? "✓" : "✗"} ${l}${d ? "  — " + d : ""}`); ok ? pass++ : fail++; };

async function call(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

const admin = (await call("/auth/login", { method: "POST", body: { email: "admin@edtech.co.uk", password: SEED_PW } })).data;
if (!admin?.token) { console.error("Could not sign in as the seeded admin — run the seed first."); process.exit(1); }

// ---------------------------------------------------------------- fixtures --
//
// Built with the bare client rather than through the API: courses, cohorts, units and
// enrolments have their own endpoints with their own rules, and this suite is about
// what publishing does, not about how a cohort gets created.
const course = await db.course.create({ data: { name: `Course ${TAG}` } });
const cohortA = await db.cohort.create({ data: { name: `SEP ${TAG} A`, courseId: course.id } });
const cohortB = await db.cohort.create({ data: { name: `SEP ${TAG} B`, courseId: course.id } });
const unit = await db.unit.create({ data: { code: `U-${TAG}`, name: `Unit ${TAG}`, courseId: course.id } });

// Two students in group A, one in group B. The third is enrolled but in NEITHER group,
// which is the control for the roster being an intersection rather than the enrolment.
const mkStudent = (n, cohortId) => db.student.create({
  data: {
    studentRef: `${TAG}-${n}`, firstName: `S${n}`, lastName: TAG,
    email: `${TAG}.${n}@example.invalid`,
    // initials and colour are NOT NULL with no default — they drive the avatar chip
    // the register screens render each student as.
    initials: "SX", colour: "#334155",
    cohortId,
  },
});
const a1 = await mkStudent("a1", cohortA.id);
const a2 = await mkStudent("a2", cohortA.id);
const b1 = await mkStudent("b1", cohortB.id);
const loose = await mkStudent("loose", null);
for (const s of [a1, a2, b1, loose]) await db.enrolment.create({ data: { studentId: s.id, unitId: unit.id } });

const D = "2027-03-01";
const mkEvent = (body) => call("/timetabling/events", { method: "POST", token: admin.token, body });
const publish = (from, to, published = true) =>
  call("/timetabling/events/publish", { method: "POST", token: admin.token, body: { from, to, published } });
const registersFor = (eventId) => db.hndSession.findMany({ where: { timetableEventId: eventId }, orderBy: { cohortId: "asc" } });

console.log("\n--- guards ---");
check("anonymous cannot list campuses", (await call("/timetabling/campuses")).status === 401);

console.log("\n--- campuses ---");
const campus = (await call("/timetabling/campuses", { method: "POST", token: admin.token, body: { name: `Campus ${TAG}` } })).data;
check("a campus was created", !!campus?.id);
check("the same campus name twice is refused", (await call("/timetabling/campuses", { method: "POST", token: admin.token, body: { name: `Campus ${TAG}` } })).status === 409);
const room = (await call("/timetabling/rooms", { method: "POST", token: admin.token, body: { name: `R-${TAG}`, campusId: campus.id } })).data;
check("a room was attached to it", room?.campusId === campus.id, String(room?.campusId));
check("and the room's label shows the campus name", room?.label?.includes(`Campus ${TAG}`), room?.label);

const delCampus = await call(`/timetabling/campuses/${campus.id}`, { method: "DELETE", token: admin.token });
check("DELETING A CAMPUS WITH ROOMS DEACTIVATES IT RATHER THAN DETACHING THEM", delCampus.data?.deactivated === true, JSON.stringify(delCampus.data));
check("and the room is still on it", (await db.room.findUnique({ where: { id: room.id } }))?.campusId === campus.id);
await call(`/timetabling/campuses/${campus.id}`, { method: "PUT", token: admin.token, body: { active: true } });

console.log("\n--- named groups, filled in one action ---");
const inGroupA = await call(`/hnd/cohorts/${cohortA.id}/students`, { token: admin.token });
check("a group lists its members", inGroupA.status === 200 && inGroupA.data.length === 2, `${inGroupA.data?.length}`);

// `loose` is enrolled on the module but in NO group. Adding them proves the group is
// filled by an explicit act rather than derived from enrolment.
const added = await call(`/hnd/cohorts/${cohortA.id}/students`, { method: "POST", token: admin.token, body: { studentIds: [loose.id] } });
check("students can be added to a group in one call", added.data?.changed === 1, JSON.stringify(added.data));
check("and an unassigned student is not reported as moved", (added.data?.moved || []).length === 0);

// b1 is in group B. Adding them to A must MOVE them, and say so — Student.cohortId is
// a single column, so there is no way to be in both, and an administrator adding forty
// people has no other way to notice they have emptied another class.
const movedRes = await call(`/hnd/cohorts/${cohortA.id}/students`, { method: "POST", token: admin.token, body: { studentIds: [b1.id] } });
check("MOVING A STUDENT BETWEEN GROUPS IS REPORTED, NOT SILENT",
  (movedRes.data?.moved || []).some((m) => m.studentRef === `${TAG}-b1`), JSON.stringify(movedRes.data?.moved));
check("and group B is now empty", (await db.student.count({ where: { cohortId: cohortB.id } })) === 0);

// Put b1 back, so the merged-class assertions below have a group B to register.
await call(`/hnd/cohorts/${cohortB.id}/students`, { method: "POST", token: admin.token, body: { studentIds: [b1.id] } });
await call(`/hnd/cohorts/${cohortA.id}/students`, { method: "DELETE", token: admin.token, body: { studentIds: [loose.id] } });
check("removing from a group empties the column rather than deleting anyone",
  (await db.student.findUnique({ where: { id: loose.id } }))?.cohortId === null);
check("an empty studentIds list is refused",
  (await call(`/hnd/cohorts/${cohortA.id}/students`, { method: "POST", token: admin.token, body: { studentIds: [] } })).status === 400);

console.log("\n--- one request, a whole series ---");
// 2027-03-01 is a Monday. Mon+Thu over three weeks = 6 classes.
const series = await call("/timetabling/events", { method: "POST", token: admin.token, body: {
  date: "2027-03-01", endDate: "2027-03-18", days: [1, 4],
  start: "09:00", end: "12:00", title: `Series ${TAG}`, unitId: unit.id, cohortIds: [cohortA.id],
} });
check("a date range creates the whole series in one call", series.data?.created === 6, `created ${series.data?.created}`);
check("MULTI-WEEKDAY: both Mondays and Thursdays, in date order",
  JSON.stringify(series.data?.dates) === JSON.stringify(["2027-03-01","2027-03-04","2027-03-08","2027-03-11","2027-03-15","2027-03-18"]),
  JSON.stringify(series.data?.dates));
const seriesRows = await db.timetableEvent.findMany({ where: { seriesId: series.data?.seriesId }, select: { id: true, date: true } });
check("they share one seriesId, so the series is findable later", seriesRows.length === 6, `${seriesRows.length}`);
check("and a single-date create still returns created:1",
  (await call("/timetabling/events", { method: "POST", token: admin.token, body: { date: "2027-03-02", start: "09:00", end: "10:00", title: `Single ${TAG}` } })).data?.created === 1);

// A range naming a weekday that never falls in it is a real answer, not an empty success.
const impossible = await call("/timetabling/events", { method: "POST", token: admin.token, body: {
  date: "2027-03-01", endDate: "2027-03-01", days: [6], start: "09:00", end: "10:00", title: `Nope ${TAG}`,
} });
check("a range containing none of the chosen days is REFUSED, not silently empty",
  impossible.status === 400 && /No dates fall/i.test(impossible.data?.error || ""), `${impossible.status} ${impossible.data?.error}`);

// Bank holidays are skipped unless the caller opts out. Easter Monday 2027 is 29 March.
const overEaster = await call("/timetabling/events", { method: "POST", token: admin.token, body: {
  date: "2027-03-22", endDate: "2027-04-05", days: [1], start: "09:00", end: "10:00", title: `Easter ${TAG}`,
} });
check("UK bank holidays are skipped by default", !(overEaster.data?.dates || []).includes("2027-03-29"), JSON.stringify(overEaster.data?.dates));
const keepEaster = await call("/timetabling/events", { method: "POST", token: admin.token, body: {
  date: "2027-03-22", endDate: "2027-04-05", days: [1], start: "14:00", end: "15:00", title: `EasterKeep ${TAG}`, skipBankHolidays: false,
} });
check("but a college that teaches on them can say so", (keepEaster.data?.dates || []).includes("2027-03-29"), JSON.stringify(keepEaster.data?.dates));

console.log("\n--- two sessions in one day: one class, TWO registers ---");
//
// The owner's requirement in one sentence: "scheduling will create the register as per
// sessions". A day with a morning block and an afternoon block is ONE class in the
// planner's head and TWO registers in the lecturer's, and neither half of that is true
// on its own. One event per day gives one register covering six hours a student may have
// attended half of — an attendance percentage that cannot distinguish "came all day"
// from "came after lunch". Two unrelated events lose the other half: cancelling the
// class has to cancel both, and nothing but a shared seriesId records that they are the
// same class.
//
// 2027-05-10 is a Monday and is NOT a bank holiday — 3 May is, 10 May is not — so the
// skipping rule above cannot quietly empty this series and make the counts below read
// as a sessions bug.
const SD = "2027-05-10";
const split = await mkEvent({
  date: SD, endDate: SD, days: [1],
  sessions: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "16:00" }],
  // start/end are sent as well, exactly as the entry screen sends them. `sessions` must
  // WIN rather than be merged with them, or a two-session day quietly becomes three
  // events and every register denominator on it is a third too big.
  start: "09:00", end: "12:00",
  title: `Split ${TAG}`, unitId: unit.id, cohortIds: [cohortA.id],
});
// Counted from the database rather than from `created`, because `created` is the number
// the handler believes and this is the number the timetable has.
const splitRows = await db.timetableEvent.findMany({
  where: { title: `Split ${TAG}` }, orderBy: { startTime: "asc" },
  select: { id: true, date: true, startTime: true, endTime: true, seriesId: true },
});
check("TWO SESSIONS OVER A ONE-DAY RANGE CREATE TWO EVENTS", splitRows.length === 2,
  `${split.status} ${split.data?.error || ""} — ${splitRows.length} rows`);
check("at the two times asked for, not one merged block",
  splitRows[0]?.startTime === "09:00" && splitRows[0]?.endTime === "12:00" &&
  splitRows[1]?.startTime === "13:00" && splitRows[1]?.endTime === "16:00",
  JSON.stringify(splitRows.map((r) => `${r.startTime}-${r.endTime}`)));
// `.every` on an empty array is true, so the length is asserted alongside it — otherwise
// a create that produced nothing at all would pass this line.
check("both on the one date the range named", splitRows.length === 2 && splitRows.every((r) => r.date === SD),
  JSON.stringify(splitRows.map((r) => r.date)));
check("and the response says how many it built per day", split.data?.sessionsPerDay === 2, JSON.stringify(split.data?.sessionsPerDay));

// The seriesId is what makes "cancel this class for the rest of term" reach the
// afternoon half. Two ids would make the pair two classes that merely look alike, and
// every later bulk action would silently do half the job. Truthiness is asserted first:
// two nulls are equal to each other, and a suite that accepted that would report a
// series where there is none.
check("BOTH SESSIONS SHARE ONE seriesId — the pair is still one class",
  !!splitRows[0]?.seriesId && splitRows[0].seriesId === splitRows[1]?.seriesId,
  JSON.stringify(splitRows.map((r) => r.seriesId)));
check("and the response names that same seriesId",
  !!split.data?.seriesId && split.data.seriesId === splitRows[0]?.seriesId, String(split.data?.seriesId));

const pubSplit = await publish(SD, SD);
check("the two-session day published", pubSplit.status === 200, String(pubSplit.status));
const splitRegs = await db.hndSession.findMany({
  where: { timetableEventId: { in: splitRows.map((r) => r.id) } },
  orderBy: { startTime: "asc" },
  select: { id: true, cohortId: true, startTime: true, endTime: true, timetableEventId: true },
});
// THE ASSERTION THIS BLOCK EXISTS FOR. Verified through the bare client because the
// publish response reports a count it computed itself; what matters is the rows.
check("PUBLISHING TWO SESSIONS CREATES TWO REGISTERS FOR ONE GROUP", splitRegs.length === 2, `got ${splitRegs.length}`);
check("one register per session, not one spanning both",
  splitRegs.length === 2 && splitRegs[0].startTime === "09:00" && splitRegs[0].endTime === "12:00" &&
  splitRegs[1].startTime === "13:00" && splitRegs[1].endTime === "16:00",
  JSON.stringify(splitRegs.map((r) => `${r.startTime}-${r.endTime}`)));
check("both for the SAME single group — two sessions, not two intakes",
  splitRegs.length === 2 && new Set(splitRegs.map((r) => r.cohortId)).size === 1 && splitRegs[0].cohortId === cohortA.id,
  JSON.stringify(splitRegs.map((r) => r.cohortId)));
check("and each hangs off its own event", splitRegs.length === 2 && new Set(splitRegs.map((r) => r.timetableEventId)).size === 2);

// Overlapping halves are a data-entry error rather than a policy a college can hold: one
// group cannot be in two places at 11:00, and a register per session would then count
// that hour twice in the same student's denominator. REFUSED — unlike a clash with
// ANOTHER event, which is only a warning above, because that one has legitimate cases
// (a room split between half-groups) and this one has none.
const overlap = await mkEvent({
  date: SD, endDate: SD, days: [1], start: "09:00", end: "12:00",
  sessions: [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "14:00" }],
  title: `Overlap ${TAG}`, unitId: unit.id, cohortIds: [cohortA.id],
});
check("OVERLAPPING SESSIONS ARE REFUSED, AND THE REASON NAMES THE OVERLAP",
  overlap.status === 400 && /overlap/i.test(overlap.data?.error || ""), `${overlap.status} ${overlap.data?.error}`);
check("and the refusal wrote nothing — not even the first, legal half",
  (await db.timetableEvent.count({ where: { title: `Overlap ${TAG}` } })) === 0);

// The mirror of it, and the one that matters more: a morning block ending exactly when
// the afternoon block starts is what a teaching day LOOKS like. A validator written as
// "end >= start" rather than "end > start" refuses every normal timetable, and the
// screen then has no way to express the thing it was built for.
const b2b = await mkEvent({
  date: SD, endDate: SD, days: [1], start: "09:00", end: "12:00",
  sessions: [{ start: "09:00", end: "12:00" }, { start: "12:00", end: "15:00" }],
  title: `BackToBack ${TAG}`, unitId: unit.id, cohortIds: [cohortA.id],
});
// The 201 is asserted TOGETHER with both halves existing, deliberately. A server that
// ignores `sessions` altogether also answers 201 — it just builds one event — so a
// status-only assertion here would pass on a build with no feature in it at all, which
// is the failure mode CLAUDE.md records having shipped twice.
const b2bRows = await db.timetableEvent.findMany({
  where: { title: `BackToBack ${TAG}` }, orderBy: { startTime: "asc" }, select: { startTime: true, endTime: true },
});
check("BACK-TO-BACK SESSIONS ARE ACCEPTED — a normal teaching day is not a clash",
  b2b.status === 201 && b2bRows.length === 2, `${b2b.status} ${b2b.data?.error || ""} — ${b2bRows.length} rows`);
check("and they meet rather than merge",
  b2bRows.length === 2 && b2bRows[0].endTime === "12:00" && b2bRows[1].startTime === "12:00",
  JSON.stringify(b2bRows.map((r) => `${r.startTime}-${r.endTime}`)));

// Two is the cap because a register is per session and a day of five sessions is five
// registers a lecturer has to take; the limit is a deliberate product decision, so the
// third is refused rather than truncated. Truncation would create two events and report
// success, and the missing afternoon would only surface when nobody had a register for
// it.
const three = await mkEvent({
  date: SD, endDate: SD, days: [1], start: "09:00", end: "11:00",
  sessions: [{ start: "09:00", end: "11:00" }, { start: "11:30", end: "13:00" }, { start: "14:00", end: "16:00" }],
  title: `Three ${TAG}`, unitId: unit.id, cohortIds: [cohortA.id],
});
check("A THIRD SESSION IN ONE DAY IS REFUSED", three.status === 400, `${three.status} ${three.data?.error || ""}`);
check("and none of the three was created — not silently truncated to two",
  (await db.timetableEvent.count({ where: { title: `Three ${TAG}` } })) === 0);

// The single-event path already refuses this; the sessions path is a second entry to the
// same column and has to refuse it too. A register from 14:00 to 09:00 is a negative
// hour, which every duration figure downstream would happily average.
const backwards = await mkEvent({
  date: SD, endDate: SD, days: [1], start: "09:00", end: "12:00",
  sessions: [{ start: "14:00", end: "09:00" }],
  title: `Backwards ${TAG}`, unitId: unit.id, cohortIds: [cohortA.id],
});
check("A SESSION ENDING BEFORE IT STARTS IS REFUSED", backwards.status === 400, `${backwards.status} ${backwards.data?.error || ""}`);
check("and nothing was created", (await db.timetableEvent.count({ where: { title: `Backwards ${TAG}` } })) === 0);

console.log("\n--- schools, and the events that belong to one ---");
//
// "School" is what this screen calls an AcademicDepartment — the same table
// academicDepartments.js configures from Settings, exposed here because a scheduler
// placing a class should not have to leave the planner to name the school it belongs to.
// The list names the college's internal structure, so it sits behind the same login as
// everything else in this router.
check("ANONYMOUS CANNOT LIST SCHOOLS", (await call("/timetabling/departments")).status === 401,
  String((await call("/timetabling/departments")).status));

const schoolName = `School ${TAG}`;
const school = await call("/timetabling/departments", { method: "POST", token: admin.token, body: { name: schoolName } });
check("a school was created", school.status === 201 && !!school.data?.id, `${school.status} ${JSON.stringify(school.data)}`);
check("and it came back with a colour to draw it in", typeof school.data?.colour === "string" && school.data.colour.length > 0, String(school.data?.colour));

// Case-INSENSITIVELY, because "Business" and "business" are one school to everybody
// except the database. A list holding both is a filter that silently shows half the
// timetable, and the half it hides is whichever one the scheduler did not pick.
const dupSchool = await call("/timetabling/departments", { method: "POST", token: admin.token, body: { name: schoolName.toUpperCase() } });
check("THE SAME SCHOOL NAME IN A DIFFERENT CASE IS REFUSED", dupSchool.status === 409, `${dupSchool.status} ${JSON.stringify(dupSchool.data)}`);
check("and no second row was written",
  (await db.academicDepartment.count({ where: { name: { contains: TAG, mode: "insensitive" } } })) === 1);

const schools = await call("/timetabling/departments", { token: admin.token });
check("the new school is on the list", Array.isArray(schools.data) && schools.data.some((d) => d.id === school.data?.id && d.name === schoolName),
  `${schools.status} ${JSON.stringify(schools.data)}`);

// READ BACK FROM THE DATABASE, NOT FROM THE RESPONSE. A handler that echoes its own
// input and never writes the column is indistinguishable from a working one at the API
// boundary, and the failure surfaces a term later as a school filter showing an empty
// week.
const owned = (await mkEvent({
  date: SD, start: "16:30", end: "17:30", title: `Owned ${TAG}`,
  unitId: unit.id, cohortIds: [cohortA.id], academicDepartmentId: school.data?.id || "",
})).data?.event;
check("an event was created with a school on it", !!owned?.id);
const ownedRow = owned?.id
  ? await db.timetableEvent.findUnique({ where: { id: owned.id }, select: { academicDepartmentId: true } })
  : null;
check("THE SCHOOL IS STORED ON THE EVENT, NOT MERELY ECHOED",
  !!school.data?.id && ownedRow?.academicDepartmentId === school.data.id, String(ownedRow?.academicDepartmentId));

// "" is how a screen says "no school" without a second verb, matching every other
// nullable relation on this route. It must land as NULL: TimetableEvent's null is a
// DECISION — "shown to everyone" — and an empty string is a foreign key to nothing that
// no scoping rule reads as either answer.
const unowned = (await mkEvent({ date: SD, start: "17:30", end: "18:30", title: `Unowned ${TAG}`, academicDepartmentId: "" })).data?.event;
check("an empty school clears the link rather than storing a blank",
  !!unowned?.id && (await db.timetableEvent.findUnique({ where: { id: unowned.id }, select: { academicDepartmentId: true } }))?.academicDepartmentId === null);

console.log("\n--- a draft event builds nothing ---");
const draft = (await mkEvent({ date: D, start: "09:00", end: "12:00", title: `Draft ${TAG}`, unitId: unit.id, cohortIds: [cohortA.id] })).data?.event;
check("a draft event was created", !!draft?.id);
check("A DRAFT EVENT HAS NO REGISTER", (await registersFor(draft.id)).length === 0);

console.log("\n--- publishing builds one register per group ---");
const merged = (await mkEvent({
  date: D, start: "14:00", end: "17:00", title: `Merged ${TAG}`,
  unitId: unit.id, roomId: room.id, cohortIds: [cohortA.id, cohortB.id],
})).data?.event;
check("a merged event was created", !!merged?.id);

const pub = await publish(D, D);
check("the publish reported what it created", typeof pub.data?.registers?.created === "number", JSON.stringify(pub.data?.registers));

const mergedRegs = await registersFor(merged.id);
check("A MERGED CLASS KEEPS TWO SEPARATE REGISTERS", mergedRegs.length === 2, `got ${mergedRegs.length}`);
check("one per group, not two for one group", new Set(mergedRegs.map((r) => r.cohortId)).size === 2);
check("both carry the event's real times", mergedRegs.every((r) => r.startTime === "14:00" && r.endTime === "17:00"), JSON.stringify(mergedRegs.map((r) => r.startTime)));
check("both carry the event's room", mergedRegs.every((r) => r.roomId === room.id));
check("and the date is the event's, not a generated one", mergedRegs.every((r) => r.date === D));

console.log("\n--- the roster is the group intersected with enrolment ---");
// The registers start empty, so the roster is proved by marking one student and
// checking the OTHER group's register is untouched — see the merged-class assertion
// below. What is asserted here is that no marks were pre-seeded.
check("A NEW REGISTER IS EMPTY — nobody is pre-marked absent",
  (await db.attendanceMark.count({ where: { sessionId: { in: mergedRegs.map((r) => r.id) } } })) === 0);

console.log("\n--- an event with no module gets no register, and says why ---");
const workshop = (await mkEvent({ date: D, start: "18:00", end: "19:00", title: `Workshop ${TAG}`, cohortIds: [cohortA.id] })).data?.event;
const pubWorkshop = await publish(D, D);
check("the workshop was published", pubWorkshop.status === 200);
check("A UNITLESS EVENT HAS NO REGISTER", (await registersFor(workshop.id)).length === 0);
check("and the reason names it as not a taught session",
  (pubWorkshop.data?.registers?.skipped || []).some((s) => /not a taught session/i.test(s.reason)),
  JSON.stringify(pubWorkshop.data?.registers?.skipped));

console.log("\n--- an UNMARKED register follows the event ---");
const moved = await call(`/timetabling/events/${merged.id}`, { method: "PUT", token: admin.token, body: { start: "15:00", end: "18:00" } });
check("the event was moved", moved.status === 200, String(moved.status));
const afterMove = await registersFor(merged.id);
check("both registers followed it", afterMove.every((r) => r.startTime === "15:00" && r.endTime === "18:00"), JSON.stringify(afterMove.map((r) => r.startTime)));
check("and nothing was reported as frozen", (moved.data?.registers?.frozen || []).length === 0);

console.log("\n--- a MARKED register does NOT follow, and says so ---");
const regA = afterMove.find((r) => r.cohortId === cohortA.id);
const regB = afterMove.find((r) => r.cohortId === cohortB.id);
await db.attendanceMark.create({ data: { sessionId: regA.id, studentId: a1.id, status: "P", takenBy: "smoke" } });

const moved2 = await call(`/timetabling/events/${merged.id}`, { method: "PUT", token: admin.token, body: { start: "16:00", end: "19:00" } });
check("the event moved again", moved2.status === 200);
const regAAfter = await db.hndSession.findUnique({ where: { id: regA.id } });
const regBAfter = await db.hndSession.findUnique({ where: { id: regB.id } });
check("THE MARKED REGISTER DID NOT MOVE", regAAfter.startTime === "15:00", regAAfter.startTime);
check("and the response reported it as frozen",
  (moved2.data?.registers?.frozen || []).some((f) => f.sessionId === regA.id),
  JSON.stringify(moved2.data?.registers?.frozen));
check("the reason says the register has already been taken",
  /already been taken/i.test((moved2.data?.registers?.frozen || [])[0]?.reason || ""));
check("the UNMARKED sibling still followed", regBAfter.startTime === "16:00", regBAfter.startTime);

console.log("\n--- a mark on one group's register is not on the other's ---");
check("group A's register has the mark", (await db.attendanceMark.count({ where: { sessionId: regA.id } })) === 1);
check("GROUP B'S REGISTER DOES NOT", (await db.attendanceMark.count({ where: { sessionId: regB.id } })) === 0);

console.log("\n--- deleting an event never deletes attendance ---");
const delEvent = await call(`/timetabling/events/${merged.id}`, { method: "DELETE", token: admin.token });
check("the event was deleted", delEvent.status === 200, String(delEvent.status));
const survivor = await db.hndSession.findUnique({ where: { id: regA.id } });
check("THE MARKED REGISTER SURVIVED", !!survivor);
check("unlinked from the event it came from", survivor?.timetableEventId === null, String(survivor?.timetableEventId));
check("and the mark is still there", (await db.attendanceMark.count({ where: { sessionId: regA.id } })) === 1);

// ------------------------------------------------------------------ cleanup --
await db.attendanceMark.deleteMany({ where: { student: { lastName: TAG } } });
await db.hndSession.deleteMany({ where: { unitId: unit.id } });
await db.enrolment.deleteMany({ where: { unitId: unit.id } });
await db.student.deleteMany({ where: { lastName: TAG } });
await db.timetableEvent.deleteMany({ where: { title: { contains: TAG } } });
// After the events, which point at it. Matched case-insensitively because the duplicate
// the 409 assertion sends is the same name uppercased — if that guard ever regresses and
// the row IS created, this is what stops it outliving the run.
await db.academicDepartment.deleteMany({ where: { name: { contains: TAG, mode: "insensitive" } } });
await db.unit.delete({ where: { id: unit.id } }).catch(() => {});
await db.cohort.deleteMany({ where: { courseId: course.id } });
await db.room.deleteMany({ where: { name: `R-${TAG}` } });
await db.campus.deleteMany({ where: { name: `Campus ${TAG}` } });
await db.course.delete({ where: { id: course.id } }).catch(() => {});
await db.$disconnect();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
