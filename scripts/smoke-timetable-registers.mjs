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
await db.unit.delete({ where: { id: unit.id } }).catch(() => {});
await db.cohort.deleteMany({ where: { courseId: course.id } });
await db.room.deleteMany({ where: { name: `R-${TAG}` } });
await db.campus.deleteMany({ where: { name: `Campus ${TAG}` } });
await db.course.delete({ where: { id: course.id } }).catch(() => {});
await db.$disconnect();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
