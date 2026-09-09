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

console.log("\n--- CREATING a published series builds its registers, across the whole range ---");
//
// Registers used to be built ONLY by publish and by an edit, so saving produced a term
// of classes with no attendance behind them and the workflow depended on the reader
// noticing a sentence in a toast. Reported as exactly that: sessions, but no attendance.
//
// The assertion that matters is the LAST date, not the first. Building registers for the
// event in front of you and calling it done is the plausible half-fix, and it passes any
// check aimed at the start of the series while leaving every later week bare.
const ONCREATE_FROM = "2026-10-05";       // a Monday
const ONCREATE_TO = "2026-10-26";         // three Mondays later
const onCreateSeries = await mkEvent({
  date: ONCREATE_FROM, endDate: ONCREATE_TO, days: [1],
  start: "09:00", end: "12:00", title: `OnCreate ${TAG}`,
  unitId: unit.id, roomId: room.id, cohortIds: [cohortA.id], published: true,
});
check("the series was created", onCreateSeries.status === 201, `${onCreateSeries.status} ${onCreateSeries.data?.error || ""}`);
check("it spans four Mondays", onCreateSeries.data?.created === 4, `created ${onCreateSeries.data?.created}`);
check("THE CREATE ITSELF REPORTS REGISTERS, rather than telling the reader to go and publish",
  onCreateSeries.data?.registers?.created === 4, JSON.stringify(onCreateSeries.data?.registers));

const onCreateRows = await db.timetableEvent.findMany({
  where: { title: `OnCreate ${TAG}` }, select: { id: true, date: true }, orderBy: { date: "asc" },
});
check("four events are in the database", onCreateRows.length === 4, String(onCreateRows.length));
check("the FIRST date has a register", (await registersFor(onCreateRows[0].id)).length === 1);
check("AND SO DOES THE LAST — registers cover the whole range, not just the date in hand",
  (await registersFor(onCreateRows[onCreateRows.length - 1].id)).length === 1,
  `last event ${onCreateRows[onCreateRows.length - 1]?.date}`);
check("every event in the series has exactly one register",
  (await Promise.all(onCreateRows.map((e) => registersFor(e.id)))).every((r) => r.length === 1));
// A draft series must still build nothing, or "build on create" has quietly become
// "build regardless of published", which is the rule the draft check above protects.
const onCreateDraft = await mkEvent({
  date: ONCREATE_FROM, endDate: ONCREATE_TO, days: [2],
  start: "09:00", end: "12:00", title: `OnCreateDraft ${TAG}`,
  unitId: unit.id, cohortIds: [cohortA.id], published: false,
});
check("A DRAFT SERIES STILL BUILDS NO REGISTERS", onCreateDraft.data?.registers?.created === 0,
  JSON.stringify(onCreateDraft.data?.registers));


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

console.log("\n--- groups and courses: what the planner picks a class FOR ---");
//
// The planner needs three lists before it can place anything: the schools, the courses
// inside one, and the named groups inside those. The schools half is above; this is the
// other two. A group is a Cohort — "SEP 25 A" — and the screen has to be able to rename
// one and delete one it created by mistake, without either action being able to reach
// the students standing in it.
//
// The fixture course is put into the school created above, because a group's school is
// what the planner filters the whole picker by, and a course belonging to nobody proves
// nothing about resolution. BOTH columns are set: Cohort.academicDepartmentId is
// denormalised from the course (see the schema comment on it), so a server reading
// either one is answering honestly, and this assertion should not be a bet on which hop
// it happened to take.
const schoolId = school.data?.id;
await db.course.update({ where: { id: course.id }, data: { academicDepartmentId: schoolId } });
await db.cohort.updateMany({ where: { courseId: course.id }, data: { academicDepartmentId: schoolId } });

// A second course in NO school, with a group on it. It is the control for two separate
// assertions: the course filter must exclude it, and renaming its group to a name group A
// already holds must be ALLOWED, because the uniqueness is per course.
const otherCourse = await db.course.create({ data: { name: `Other Course ${TAG}` } });
const otherGroup = await db.cohort.create({ data: { name: `Rename ${TAG}`, courseId: otherCourse.id } });
// An empty group on the fixture course — the only kind that may be deleted.
const emptyGroup = await db.cohort.create({ data: { name: `Empty ${TAG}`, courseId: course.id, academicDepartmentId: schoolId } });

const groups = await call("/timetabling/groups", { token: admin.token });
const gRows = Array.isArray(groups.data) ? groups.data : [];
const gA = gRows.find((g) => g.id === cohortA.id);
const gEmpty = gRows.find((g) => g.id === emptyGroup.id);
check("the group list came back and holds the fixture groups", groups.status === 200 && !!gA && !!gEmpty,
  `${groups.status} ${String(JSON.stringify(groups.data)).slice(0, 160)}`);

// A GROUP CARRIES ITS SCHOOL'S NAME. An id alone makes the planner fetch the schools list
// and join it in the browser, and a screen that joins in the browser shows a blank wherever
// the two requests disagree — a school renamed between them, or one the second request
// filtered out. The name is the thing being asserted; the id is asserted beside it so that
// a handler returning the right name against the wrong school cannot pass.
check("A GROUP RESOLVES ITS SCHOOL TO A NAME, NOT JUST AN ID",
  !!schoolId && gA?.academicDepartmentId === schoolId && gA?.schoolName === schoolName,
  `${gA?.academicDepartmentId} / ${gA?.schoolName}`);
check("and names its course the same way", gA?.courseId === course.id && gA?.courseName === `Course ${TAG}`,
  `${gA?.courseId} / ${gA?.courseName}`);

// COUNTED FROM THE DATABASE, never compared against the API's own arithmetic. A full group
// and an empty one are both asserted, deliberately: a handler that hardcodes 0, or returns
// the course's total, or the enrolment count, passes exactly one of these two lines. Either
// on its own is a number that merely looks plausible.
const realA = await db.student.count({ where: { cohortId: cohortA.id } });
check("the fixture group really does hold two students", realA === 2, `${realA}`);
check("studentCount IS THE REAL COUNT, taken from the database rather than the response",
  realA === 2 && gA?.studentCount === realA, `api ${gA?.studentCount} vs db ${realA}`);
check("and an empty group counts zero rather than inheriting its course's total",
  gEmpty?.studentCount === 0, `${gEmpty?.studentCount}`);

console.log("\n--- renaming a group: unique PER COURSE, not globally ---");
const renamed = await call(`/timetabling/groups/${emptyGroup.id}`, { method: "PUT", token: admin.token, body: { name: `Empty ${TAG} B` } });
check("a group can be renamed", renamed.status === 200, `${renamed.status} ${renamed.data?.error || ""}`);
check("and the new name is IN THE DATABASE, not merely echoed back",
  (await db.cohort.findUnique({ where: { id: emptyGroup.id } }))?.name === `Empty ${TAG} B`);

// THE ASSERTION THAT SEPARATES "unique per course" FROM "unique globally". Every college
// names its intakes the same way — "SEP 25", "JAN 26" — so the same label on two different
// courses is the NORMAL case, not a collision, and the schema says so with
// @@unique([courseId, name]). A handler that checks the name across the whole table
// refuses the second course's September intake, and nobody finds out until the second
// course tries to have one.
const crossCourse = await call(`/timetabling/groups/${otherGroup.id}`, { method: "PUT", token: admin.token, body: { name: `SEP ${TAG} A` } });
check("THE SAME GROUP NAME ON A DIFFERENT COURSE IS ACCEPTED",
  crossCourse.status === 200, `${crossCourse.status} ${crossCourse.data?.error || ""}`);
const bothNamed = await db.cohort.count({ where: { name: `SEP ${TAG} A` } });
check("and both groups now carry that name, each on its own course", bothNamed === 2, `${bothNamed}`);

// The mirror of it. Two groups on ONE course called "SEP 25 A" is a lecturer picking a
// register by name and getting a coin toss.
const sameCourse = await call(`/timetabling/groups/${cohortB.id}`, { method: "PUT", token: admin.token, body: { name: `SEP ${TAG} A` } });
check("RENAMING TO A NAME ALREADY USED ON THE SAME COURSE IS REFUSED", sameCourse.status === 409,
  `${sameCourse.status} ${sameCourse.data?.error || ""}`);
check("and group B kept the name it had",
  (await db.cohort.findUnique({ where: { id: cohortB.id } }))?.name === `SEP ${TAG} B`);

console.log("\n--- deleting a group: never out from under the students ---");
//
// THE ASSERTION IN THIS SECTION THAT MATTERS MOST. Student.cohortId is onDelete: SetNull,
// so a delete that got through does not fail loudly — it SUCCEEDS, and a whole class
// quietly stops belonging to any group. Nothing afterwards records which group they were
// in, so it is not recoverable from the data; it has to be reconstructed from somebody's
// memory. The 409 is checked, and then the students are counted again through the bare
// client, because "the refusal was reported" and "the rows survived" are not the same
// fact — a handler that deletes and then answers 409 passes the first and fails the
// second, and that is precisely the bug worth catching.
const delFull = await call(`/timetabling/groups/${cohortA.id}`, { method: "DELETE", token: admin.token });
check("DELETING A GROUP THAT HAS STUDENTS IN IT IS REFUSED", delFull.status === 409,
  `${delFull.status} ${JSON.stringify(delFull.data)}`);
// The count, not just "some students". An administrator seeing "this group is not empty"
// has to open another screen to find out how many; the number is what tells them whether
// they mistyped or are about to strand thirty people.
check("and the refusal NAMES how many students are in the way",
  new RegExp(`(^|\\D)${realA}(\\D|$)`).test(delFull.data?.error || ""), JSON.stringify(delFull.data?.error));
const stillIn = await db.student.count({ where: { cohortId: cohortA.id } });
check("THE STUDENTS STILL HAVE THEIR GROUP — a delete that slipped through would detach a whole class silently",
  stillIn === realA, `${stillIn} of ${realA}`);
check("and the group row itself is still there",
  !!(await db.cohort.findUnique({ where: { id: cohortA.id } })));

// The other half, and it has to be here: a group created by mistake, with nobody in it,
// must be removable. Otherwise the screen grows a permanent list of typos and the safe
// refusal above becomes a reason to empty a group first and delete it afterwards — which
// is the detachment, done by hand.
const delEmpty = await call(`/timetabling/groups/${emptyGroup.id}`, { method: "DELETE", token: admin.token });
check("AN EMPTY GROUP IS DELETED", delEmpty.status === 200, `${delEmpty.status} ${delEmpty.data?.error || ""}`);
check("and the row is gone from the database, not merely reported gone",
  (await db.cohort.findUnique({ where: { id: emptyGroup.id } })) === null);

console.log("\n--- courses, filtered by school ---");
const filtered = await call(`/timetabling/courses?academicDepartmentId=${schoolId}`, { token: admin.token });
const fRows = Array.isArray(filtered.data) ? filtered.data : [];
const allCourses = await call("/timetabling/courses", { token: admin.token });
const aRows = Array.isArray(allCourses.data) ? allCourses.data : [];
check("the filtered list holds the course that belongs to this school",
  filtered.status === 200 && fRows.some((c) => c.id === course.id), `${filtered.status} ${fRows.length} rows`);
// The negative half, and the one that carries the weight. A filter that is parsed and then
// ignored returns EVERYTHING, and everything contains the right answer — so "the course is
// in the list" passes against a build with no filtering in it at all.
// `fRows.length > 0` is carried here rather than left to the next line: "the schoolless
// course is absent" is true of an EMPTY list, so on a build with no route at all this
// passed green off a 404 — a line reporting coverage of the exact filter that does not
// exist. Requiring the list to be non-empty is what makes the absence mean something.
check("AND NOT THE COURSE THAT BELONGS TO NO SCHOOL",
  fRows.length > 0 && !fRows.some((c) => c.id === otherCourse.id),
  JSON.stringify(fRows.map((c) => c.name)));
check("every row it returned really carries the school asked for",
  fRows.length > 0 && fRows.every((c) => c.academicDepartmentId === schoolId),
  JSON.stringify(fRows.map((c) => c.academicDepartmentId)));
check("while the UNFILTERED call returns more, the schoolless course among them",
  aRows.length > fRows.length && aRows.some((c) => c.id === otherCourse.id),
  `${aRows.length} unfiltered vs ${fRows.length} filtered`);

console.log("\n--- approving a sign-up INTO a school ---");
//
// A member of staff is scoped by the schools they belong to, and the moment that belonging
// is decided is the approval: the admin reading the request is the only person who knows
// which school the applicant is joining. Doing it afterwards leaves an account existing
// for a while scoped to nothing, which — depending on which way the scope guard fails —
// is either an account that can see nothing or one that can see the whole college.
const SIGNUP_PW = "Password123";
const pendingByEmail = async (email) =>
  ((await call("/signup?status=pending", { token: admin.token })).data || []).find((r) => r.email === email);

const staffEmail = `${TAG}.staff@example.invalid`;
await call("/signup", { method: "POST", body: {
  name: `Staffer ${TAG}`, email: staffEmail, password: SIGNUP_PW, confirmPassword: SIGNUP_PW,
  position: "Lecturer", dept: "Teaching",
} });
const staffReq = await pendingByEmail(staffEmail);
check("a staff sign-up request is waiting", !!staffReq?.id, JSON.stringify(staffReq));
const approved = await call(`/signup/${staffReq?.id}/decision`, { method: "PUT", token: admin.token, body: { status: "approved", academicDepartmentId: schoolId } });
check("approving it with a school on the decision succeeds", approved.status === 201,
  `${approved.status} ${approved.data?.error || ""}`);
// Looked up by email through the bare client rather than read out of the response: the
// link is a row in a second table, and a handler that accepts the field and never writes
// it is indistinguishable from a working one at the API boundary.
const newStaff = await db.staff.findFirst({ where: { email: staffEmail } });
check("the staff account was created", !!newStaff?.id);
const links = newStaff ? await db.staffAcademicDepartment.findMany({ where: { staffId: newStaff.id } }) : [];
check("APPROVING WITH A SCHOOL CREATES THE StaffAcademicDepartment LINK",
  links.length === 1 && links[0].academicDepartmentId === schoolId,
  JSON.stringify(links.map((l) => l.academicDepartmentId)));

// Not mandatory, and that is a decision rather than an oversight. Most colleges scope
// nobody at all; a required field here would stop every one of them approving anybody, and
// the ones that do scope have staff — finance, admissions, the registry — who legitimately
// belong to no school and must not be given one to get an account made.
const staffEmail2 = `${TAG}.staff2@example.invalid`;
await call("/signup", { method: "POST", body: {
  name: `Staffer2 ${TAG}`, email: staffEmail2, password: SIGNUP_PW, confirmPassword: SIGNUP_PW,
  position: "Registrar", dept: "Registry",
} });
const staffReq2 = await pendingByEmail(staffEmail2);
const approved2 = await call(`/signup/${staffReq2?.id}/decision`, { method: "PUT", token: admin.token, body: { status: "approved" } });
check("APPROVING WITHOUT A SCHOOL STILL SUCCEEDS — the field is not mandatory",
  approved2.status === 201, `${approved2.status} ${approved2.data?.error || ""}`);
const newStaff2 = await db.staff.findFirst({ where: { email: staffEmail2 } });
check("that account exists too", !!newStaff2?.id);
check("and it is scoped to no school at all, rather than to a default one",
  !!newStaff2 && (await db.staffAcademicDepartment.count({ where: { staffId: newStaff2.id } })) === 0);

// A student request has no school to belong to — students are scoped through their cohort,
// not through StaffAcademicDepartment — so the field must be inert on that path rather
// than fatal to it. The admin screen sends one body shape for both kinds, and a validator
// that rejects an unexpected field would break student approval for a reason no message
// on the screen could explain.
const linksBefore = await db.staffAcademicDepartment.count({ where: { academicDepartmentId: schoolId } });
const studentEmail = `${TAG}.learner@example.invalid`;
await call("/signup", { method: "POST", body: {
  kind: "student", name: `Learner ${TAG}`, email: studentEmail, collegeId: `${TAG}-su`,
  password: SIGNUP_PW, confirmPassword: SIGNUP_PW,
} });
const stuReq = await pendingByEmail(studentEmail);
check("a student sign-up request is waiting", !!stuReq?.id, JSON.stringify(stuReq));
const stuApproved = await call(`/signup/${stuReq?.id}/decision`, { method: "PUT", token: admin.token, body: { status: "approved", academicDepartmentId: schoolId } });
check("A STUDENT SIGN-UP IS UNAFFECTED BY THE SCHOOL FIELD — it still approves",
  stuApproved.status === 201, `${stuApproved.status} ${stuApproved.data?.error || ""}`);
check("and it created a student account", !!(await db.student.findFirst({ where: { email: studentEmail } })));
check("with no staff-school link invented for them",
  (await db.staffAcademicDepartment.count({ where: { academicDepartmentId: schoolId } })) === linksBefore,
  `${await db.staffAcademicDepartment.count({ where: { academicDepartmentId: schoolId } })} vs ${linksBefore}`);

console.log("\n--- the events list: how many, and which ---");
// The Events tab asks a different question from the calendar: not "what is on this
// week" but "what exists at all". Its endpoint therefore reports a TOTAL taken before
// the page limit, and says so when it has capped.
const listAll = await call("/timetabling/events/list", { token: admin.token });
check("the events list answers", listAll.status === 200, String(listAll.status));
check("IT REPORTS A TOTAL, not just the rows it returned",
  typeof listAll.data?.total === "number" && listAll.data.total >= (listAll.data.events || []).length,
  `total ${listAll.data?.total} vs ${(listAll.data?.events || []).length} rows`);
check("and says whether it truncated, in both directions", typeof listAll.data?.truncated === "boolean");

// Filtering must narrow the ROWS without changing what "total" means — the screen
// prints "6 of 842", and a total that shrank with the filter would make that a lie.
const mine = await call(`/timetabling/events/list?q=${encodeURIComponent(TAG)}`, { token: admin.token });
check("a search narrows the rows", (mine.data?.events || []).length < (listAll.data?.events || []).length + 1);
check("EVERY ROW RETURNED ACTUALLY MATCHES the search",
  (mine.data?.events || []).every((e) => JSON.stringify(e).includes(TAG)),
  `${(mine.data?.events || []).length} rows`);
check("a nonsense search returns nothing rather than everything",
  ((await call("/timetabling/events/list?q=zzz-no-such-class-zzz", { token: admin.token })).data?.events || []).length === 0);

// published is a THREE-state filter — true, false, or absent meaning both. A handler
// that treated absent as "true" would hide every draft from the screen built to find them.
const drafts = await call("/timetabling/events/list?published=false", { token: admin.token });
const live = await call("/timetabling/events/list?published=true", { token: admin.token });
check("published=false returns only drafts", (drafts.data?.events || []).every((e) => e.published === false));
check("published=true returns only published ones", (live.data?.events || []).every((e) => e.published === true));
check("and omitting it returns BOTH, not one of them",
  listAll.data?.total === (drafts.data?.total || 0) + (live.data?.total || 0),
  `${listAll.data?.total} vs ${drafts.data?.total} + ${live.data?.total}`);

check("an inverted date range is refused",
  (await call("/timetabling/events/list?from=2027-10-01&to=2027-09-01", { token: admin.token })).status === 400);

console.log("\n--- A GROUP'S STUDENTS APPEAR ON ITS REGISTER, WITH NO ENROLMENTS AT ALL ---");
//
// The fatal one, reported from production: eighteen registers, each saying on its own
// face "All students in the group (no enrolment data for this module)", every one of
// them listing nobody.
//
// Two endpoints answered "who is on this register" differently. syncEventRegisters chose
// a roster — cohort intersected with enrolment, falling back to the WHOLE cohort when the
// module records no enrolments at all — and then kept only a sentence, throwing the list
// away. GET /sessions/:id/register read Enrolment and never looked at cohortId, so it
// showed nobody; PUT gated on Enrolment too, so even a hand-built list could not be
// marked. Both were individually defensible. Together they were a register nobody could
// take.
//
// The fixture is the production case exactly: a module with ZERO enrolments and a group
// with students in it. A unit carrying both would be served correctly by the old code and
// prove nothing.
const noEnrolUnit = await db.unit.create({ data: { code: `NE-${TAG}`, name: `No-enrolment unit ${TAG}`, courseId: course.id } });
const cohortC = await db.cohort.create({ data: { name: `SEP ${TAG} C`, courseId: course.id } });
const c1 = await mkStudent("c1", cohortC.id);
const c2 = await mkStudent("c2", cohortC.id);
check("the fixture module has NO enrolments",
  (await db.enrolment.count({ where: { unitId: noEnrolUnit.id } })) === 0);
check("and the group has two students", (await db.student.count({ where: { cohortId: cohortC.id } })) === 2);

const neEvent = (await mkEvent({
  date: "2027-04-05", start: "09:00", end: "12:00", title: `NoEnrol ${TAG}`,
  unitId: noEnrolUnit.id, cohortIds: [cohortC.id], published: true,
})).data;
check("the class was created with a register", neEvent?.registers?.created === 1, JSON.stringify(neEvent?.registers));

const neReg = (await registersFor(neEvent.event.id))[0];
check("the register exists and is tied to the group", neReg?.cohortId === cohortC.id, String(neReg?.cohortId));
check("and describes itself as covering the whole group",
  /All students in the group/i.test(neReg?.audience || ""), neReg?.audience);

const sheet = await call(`/hnd/sessions/${neReg.id}/register`, { token: admin.token });
check("the register opens", sheet.status === 200, String(sheet.status));
check("IT LISTS THE GROUP'S STUDENTS — the sheet and its own description now agree",
  (sheet.data?.rows || []).length === 2, `${(sheet.data?.rows || []).length} row(s)`);
const listedRefs = (sheet.data?.rows || []).map((r) => r.student?.studentRef).sort();
check("and they are the right two", listedRefs.join(",") === [`${TAG}-c1`, `${TAG}-c2`].sort().join(","), listedRefs.join(","));
// `enrolled` must still tell the truth. These students are on the register through the
// group, not through an enrolment, and a screen showing a tick against "enrolled" would
// be stating something false about their academic record.
check("each row reports enrolled:false, because that is the fact",
  (sheet.data?.rows || []).every((r) => r.enrolled === false), JSON.stringify((sheet.data?.rows || []).map((r) => r.enrolled)));

const saved = await call(`/hnd/sessions/${neReg.id}/register`, {
  method: "PUT", token: admin.token, body: { marks: [{ studentId: c1.id, status: "P" }] },
});
check("A MARK CAN ACTUALLY BE SAVED — listing them and refusing the mark is the same failure",
  saved.status === 200, `${saved.status} ${saved.data?.error || ""}`);
check("and the mark is in the database", (await db.attendanceMark.count({ where: { sessionId: neReg.id, studentId: c1.id } })) === 1);

// The guard has to still refuse a stranger, or "use the roster" has quietly become
// "accept anybody" — which is how a mark, and therefore a unit, gets attached to
// somebody who was never on the course.
const strayMark = await call(`/hnd/sessions/${neReg.id}/register`, {
  method: "PUT", token: admin.token, body: { marks: [{ studentId: loose.id, status: "P" }] },
});
check("A STUDENT IN NEITHER THE GROUP NOR THE ENROLMENT IS STILL REFUSED",
  strayMark.status === 400, `${strayMark.status} ${JSON.stringify(strayMark.data)}`);
check("and no mark was written for them",
  (await db.attendanceMark.count({ where: { sessionId: neReg.id, studentId: loose.id } })) === 0);

console.log("\n--- the LIVE view shows the group too, not just the enrolled ---");
//
// The THIRD screen to build its student list from Enrolment alone. The register listed
// the group and the unit card counted the group, but the live view -- the screen a
// lecturer stands in front of a class holding -- stayed empty for exactly the classes
// the other two had just been fixed for. Found on production: BUS702 had 0 enrolments,
// a group of 7, and a live view reading "Nobody is enrolled on this unit yet".
//
// Same fixture as the register section above: a module with NO enrolments and a group
// with students in it. A unit carrying both would be served correctly by the old code.
const liveSheet = await call(`/hnd/sessions/${neReg.id}/live`, { token: admin.token });
check("the live view opens", liveSheet.status === 200, String(liveSheet.status));
check("IT LISTS THE GROUP'S STUDENTS — the same two the register shows",
  (liveSheet.data?.rows || []).length === 2, `${(liveSheet.data?.rows || []).length} row(s)`);
// Asserted as a SUM rather than a fixed notMarked, because an earlier section of this
// suite already marked one of these two students present. Pinning notMarked to 2 made
// the check depend on the order of the file rather than on the behaviour, and it failed
// for that reason on the first run. What must hold is that every student on the roster
// is accounted for exactly once — marked or not — and that "not marked" is a real
// number rather than the null a register with no roster reports.
const lc = liveSheet.data?.counts || {};
check("its counts size the roster, so 'no mark yet' is a real number and not null",
  lc.notMarked !== null && lc.notMarked !== undefined, JSON.stringify(lc));
check("and every student on the roster is counted exactly once, marked or not",
  (lc.P + lc.L + lc.E + lc.A + lc.notMarked) === 2, JSON.stringify(lc));
check("each row still reports enrolled:false, because that is the fact",
  (liveSheet.data?.rows || []).every((r) => r.enrolled === false),
  JSON.stringify((liveSheet.data?.rows || []).map((r) => r.enrolled)));
check("and the screen is told it may set a mark, so the dropdown is not offered blind",
  liveSheet.data?.canMark === true, `canMark=${liveSheet.data?.canMark}`);

// --- the columns the register screen renders ---
//
// Each is asserted for its CONTENT, not merely its presence: a row that carried the key
// with null in it would satisfy `in` and render an em dash, which is exactly the "0
// students" class of bug this suite keeps catching one screen at a time.
const liveRow = (liveSheet.data?.rows || []).find((r) => r.student?.studentRef === `${TAG}-c1`);
check("a row carries the student's full name and number", !!liveRow?.student?.name && !!liveRow?.student?.studentRef,
  `${liveRow?.student?.name} / ${liveRow?.student?.studentRef}`);
check("THE COURSE COMES THROUGH THE GROUP, so the column is not empty for a group register",
  liveRow?.course === `Course ${TAG}`, JSON.stringify(liveRow?.course));
check("and the group is named beside it", liveRow?.group === `SEP ${TAG} C`, JSON.stringify(liveRow?.group));
// A percentage of NULL is the honest answer for a student nobody has marked on this
// module; 0 would put them bottom of a list for something never measured. c1 WAS marked
// present earlier in this suite, so this one has a figure and its sibling does not.
check("ATTENDANCE % IS A REAL FIGURE where marks exist — 100 for one present, out of one",
  liveRow?.attendancePct === 100 && liveRow?.attendanceMarked === 1,
  `pct=${liveRow?.attendancePct} marked=${liveRow?.attendanceMarked}`);
const unmarkedRow = (liveSheet.data?.rows || []).find((r) => r.student?.studentRef === `${TAG}-c2`);
check("AND NULL, NOT ZERO, for a student never marked on this module",
  unmarkedRow?.attendancePct === null && unmarkedRow?.attendanceMarked === 0,
  `pct=${unmarkedRow?.attendancePct} marked=${unmarkedRow?.attendanceMarked}`);
check("school is present as a key even when the student has none, so the column renders",
  "school" in (liveRow || {}), JSON.stringify(Object.keys(liveRow || {})));

console.log("\n--- THE UNIT CARD COUNTS WHAT THE REGISTER SHOWS ---");
//
// The same failure one screen further out. Registers → Units read `studentCount` off a
// count of Enrolment rows, so BUS701–BUS705 — hand-created modules Moodle never synced —
// printed "0 students · 20 sessions" while the registers for those very classes listed
// the twenty students of the group scheduled against them. One module, two answers, on
// two screens a lecturer reads in the same minute.
//
// Both branches are asserted, because a fix that simply added the group would break the
// other half: a module that HAS enrolments must still report the intersection, or
// `loose` — enrolled but in neither group, and refused a mark above for exactly that
// reason — would be counted as somebody this module teaches.
const unitCards = await call("/hnd/units", { token: admin.token });
check("the unit list opens", unitCards.status === 200, String(unitCards.status));
const cardFor = (id) => (unitCards.data || []).find((u) => u.id === id);

// The premise, restated at the API boundary so a failure below is unambiguous.
check("the no-enrolment module still records no enrolments",
  (await db.enrolment.count({ where: { unitId: noEnrolUnit.id } })) === 0);
check("and no register of it is ungrouped — every one belongs to the group",
  (await db.hndSession.count({ where: { unitId: noEnrolUnit.id, cohortId: null } })) === 0);
check("ITS CARD REPORTS THE GROUP'S SIZE, NOT ZERO — the card and the register agree",
  cardFor(noEnrolUnit.id)?.studentCount === 2, `studentCount=${JSON.stringify(cardFor(noEnrolUnit.id)?.studentCount)}`);

check("the enrolled module has four enrolment rows",
  (await db.enrolment.count({ where: { unitId: unit.id } })) === 4);
check("AND ITS CARD STILL REPORTS THE INTERSECTION (3), not the enrolment count (4)",
  cardFor(unit.id)?.studentCount === 3, `studentCount=${JSON.stringify(cardFor(unit.id)?.studentCount)}`);

// A module with neither route to a student. Not zero: there is nothing to measure, and
// "0 students" is the sentence a genuinely empty module says.
const orphanUnit = await db.unit.create({ data: { code: `OR-${TAG}`, name: `Orphan unit ${TAG}`, courseId: course.id } });
const orphanCards = await call("/hnd/units", { token: admin.token });
const orphanCard = (orphanCards.data || []).find((u) => u.id === orphanUnit.id);
check("a module with no enrolments AND no group reports NULL, not 0",
  orphanCard?.studentCount === null, `studentCount=${JSON.stringify(orphanCard?.studentCount)}`);

// The second call site. Two handlers emitting one field is how the two screens came to
// disagree in the first place, so the attendance matrix must give the same answers.
const matrix = await call("/hnd/attendance", { token: admin.token });
check("the attendance matrix opens", matrix.status === 200, String(matrix.status));
const mUnit = (id) => (matrix.data?.units || []).find((u) => u.id === id);
check("and it agrees with the unit list on the no-enrolment module",
  mUnit(noEnrolUnit.id)?.studentCount === 2, `studentCount=${JSON.stringify(mUnit(noEnrolUnit.id)?.studentCount)}`);
check("and on the enrolled one",
  mUnit(unit.id)?.studentCount === 3, `studentCount=${JSON.stringify(mUnit(unit.id)?.studentCount)}`);


console.log("\n--- CLOSING A REGISTER REACHES ONLY THE PEOPLE ON IT ---");
//
// Four defects an adversarial sweep found, all in write or disclosure paths, all
// regressions of the same root cause the read paths were fixed for.
//
// mark-remaining-absent read enrolment.findMany({ unitId }) -- every student on the
// MODULE. On a merged class that is the other group, so closing group A's register wrote
// a permanent A against students who were in another room, dropped their percentage and
// rescored them. GET /register and GET /live refuse to list those rows, so the marks were
// invisible on the screen that made them and present in every figure.
const mergedUnit = await db.unit.create({ data: { code: `MG-${TAG}`, name: `Merged unit ${TAG}`, courseId: course.id } });
const gX = await db.cohort.create({ data: { name: `GX ${TAG}`, courseId: course.id } });
const gY = await db.cohort.create({ data: { name: `GY ${TAG}`, courseId: course.id } });
const x1 = await mkStudent("x1", gX.id);
// TWO in group X, and the second one is load-bearing. The defect below is a comparison
// of the ROSTER SIZE against the REQUEST LENGTH, so it only bites when those two numbers
// coincide -- with one student in the group they differ and the broken code passes.
const x2 = await mkStudent("x2", gX.id);
const y1 = await mkStudent("y1", gY.id);
// BOTH enrolled on the module — the ordinary Moodle case, and the one that made the
// close-off route reach across groups.
for (const st of [x1, x2, y1]) await db.enrolment.create({ data: { studentId: st.id, unitId: mergedUnit.id } });

const mgEvent = (await mkEvent({
  // PAST, deliberately: mark-remaining-absent refuses a class that has not happened
  // yet, so a future fixture tests the refusal rather than the roster.
  date: "2026-06-02", start: "09:00", end: "12:00", title: `Merge ${TAG}`,
  unitId: mergedUnit.id, cohortIds: [gX.id, gY.id], published: true,
})).data;
const mgRegs = await registersFor(mgEvent.event.id);
check("a merged class built one register per group", mgRegs.length === 2, `${mgRegs.length}`);
const regX = mgRegs.find((r) => r.cohortId === gX.id);

const closed = await call(`/hnd/sessions/${regX.id}/mark-remaining-absent`, { method: "POST", token: admin.token });
check("closing group X's register succeeds", closed.status === 200, `${closed.status} ${JSON.stringify(closed.data)}`);
check("IT MARKS THE GROUP, NOT THE MODULE — group Y was in another room",
  closed.data?.marked === 2, `marked=${closed.data?.marked}`);
check("AND NO ABSENCE WAS WRITTEN AGAINST THE OTHER GROUP'S STUDENT",
  (await db.attendanceMark.count({ where: { sessionId: regX.id, studentId: y1.id } })) === 0,
  `y1 marks on X's register: ${await db.attendanceMark.count({ where: { sessionId: regX.id, studentId: y1.id } })}`);
check("the student who WAS on it is marked absent",
  (await db.attendanceMark.count({ where: { sessionId: regX.id, studentId: x1.id, status: "A" } })) === 1);

// The mirror: on a module with no enrolments the same route found nobody and reported
// "Everyone on this register already has a mark" having written nothing. Its own past-
// dated class, for the same reason as above.
const nePast = (await mkEvent({
  date: "2026-06-03", start: "09:00", end: "12:00", title: `NoEnrolPast ${TAG}`,
  unitId: noEnrolUnit.id, cohortIds: [cohortC.id], published: true,
})).data;
const nePastReg = (await registersFor(nePast.event.id))[0];
const closedGroup = await call(`/hnd/sessions/${nePastReg.id}/mark-remaining-absent`, { method: "POST", token: admin.token });
check("CLOSING A GROUP REGISTER ON AN ENROLMENT-FREE MODULE IS NOT A SILENT NO-OP",
  closedGroup.data?.marked >= 1, `${closedGroup.status} ${JSON.stringify(closedGroup.data)}`);

console.log("\n--- correcting ONE mark does not depend on how many others you send ---");
//
// The escape hatch that keeps an already-marked student editable was gated on
// `okIds.size !== ids.length` -- the size of the ROSTER against the length of the
// REQUEST. Unrelated quantities, so whenever they coincided the top-up never ran: the
// same correction was accepted or refused by how many OTHER rows the client bundled.
await db.student.update({ where: { id: x1.id }, data: { cohortId: null } });   // x1 leaves the group, keeping their mark
// Roster is now {x2}: size 1. The request below carries 1 id. Equal, so the broken
// `okIds.size !== ids.length` skipped the top-up and refused a student on the sheet.
const aloneFix = await call(`/hnd/sessions/${regX.id}/register`, {
  method: "PUT", token: admin.token, body: { marks: [{ studentId: x1.id, status: "L" }] },
});
check("A LONE CORRECTION FOR A STUDENT WHO HAS LEFT THE GROUP IS ACCEPTED",
  aloneFix.status === 200, `${aloneFix.status} ${aloneFix.data?.error || ""}`);
check("and it was actually written", (await db.attendanceMark.count({ where: { sessionId: regX.id, studentId: x1.id, status: "L" } })) === 1);
await db.student.update({ where: { id: x1.id }, data: { cohortId: gX.id } });

console.log("\n--- the history is this student's, on this group, and only for people on the sheet ---");
const histOutsider = await call(`/hnd/sessions/${regX.id}/students/${loose.id}/history`, { token: admin.token });
check("A STUDENT NOT ON THIS REGISTER IS REFUSED — name, email and DOB are not readable through it",
  histOutsider.status === 404, `${histOutsider.status} ${histOutsider.data?.error || ""}`);
const histOwn = await call(`/hnd/sessions/${regX.id}/students/${x1.id}/history`, { token: admin.token });
check("a student on the register IS readable", histOwn.status === 200, String(histOwn.status));
check("AND THE OTHER GROUP'S REGISTERS ARE NOT COUNTED AS CLASSES THEY MISSED",
  histOwn.data?.totalSessions === 1, `totalSessions=${histOwn.data?.totalSessions}`);
check("every row it lists belongs to this student's own group or to no group",
  (histOwn.data?.rows || []).every((r) => r.sessionId === regX.id), JSON.stringify((histOwn.data?.rows || []).map((r) => r.sessionId)));

// ------------------------------------------------------------------ cleanup --
await db.attendanceMark.deleteMany({ where: { student: { lastName: TAG } } });
await db.hndSession.deleteMany({ where: { unitId: { in: [unit.id, noEnrolUnit.id, mergedUnit.id] } } });
await db.enrolment.deleteMany({ where: { unitId: { in: [unit.id, noEnrolUnit.id, mergedUnit.id] } } });
await db.student.deleteMany({ where: { lastName: TAG } });
await db.timetableEvent.deleteMany({ where: { title: { contains: TAG } } });
// The sign-up section's leavings. The links go first: they are cascaded by BOTH parents,
// but the department delete below is the guard-dependent one, and a run that failed before
// the accounts were created must still be able to drop the school.
await db.staffAcademicDepartment.deleteMany({ where: { staff: { email: { contains: TAG } } } });
await db.staff.deleteMany({ where: { email: { contains: TAG } } });
await db.signupRequest.deleteMany({ where: { email: { contains: TAG } } });
// After the events, which point at it. Matched case-insensitively because the duplicate
// the 409 assertion sends is the same name uppercased — if that guard ever regresses and
// the row IS created, this is what stops it outliving the run.
await db.academicDepartment.deleteMany({ where: { name: { contains: TAG, mode: "insensitive" } } });
// Unit.courseId is SetNull, not Cascade, so deleting the course below does NOT take
// these with it — they have to go by id or the run leaks a module a time.
await db.unit.deleteMany({ where: { id: { in: [unit.id, noEnrolUnit.id, orphanUnit.id] } } }).catch(() => {});
await db.cohort.deleteMany({ where: { courseId: course.id } });
await db.room.deleteMany({ where: { name: `R-${TAG}` } });
await db.campus.deleteMany({ where: { name: `Campus ${TAG}` } });
await db.course.delete({ where: { id: course.id } }).catch(() => {});
// The second course exists only to prove the group-name uniqueness is per course and that
// the course filter excludes what it should. Deleted by id and not by name, because one of
// the assertions above RENAMES its group and a name-matched cleanup would leave the row.
await db.cohort.deleteMany({ where: { courseId: otherCourse.id } }).catch(() => {});
await db.course.delete({ where: { id: otherCourse.id } }).catch(() => {});
await db.$disconnect();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
