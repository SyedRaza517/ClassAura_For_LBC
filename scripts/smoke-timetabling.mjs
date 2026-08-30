// CELCAT-style timetabling — the planner, the staff read, and the settings.
//
// Weighted toward NEGATIVE assertions like the other suites: who is refused, what
// never leaves the building, what a draft does not show.
//
// The assertion that matters most is "a lecturer's timetable is found by ID, not by
// name". That is the entire reason this module exists rather than a screen over
// TimetableSlot, whose `lecturer` column is free text — and it is checked by making
// a second staff member whose name CONTAINS the first's, which any name match would
// sweep up and an id join cannot.
//
// Prereq: API running (npm test boots one on 4010; npm run dev uses 4000)
// Usage:  DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node scripts/smoke-timetabling.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(pathToFileURL(join(ROOT, "server", "package.json")));
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — point it at a throwaway database."); process.exit(1); }
// A bare client, deliberately: it verifies what the API did, so it must not be the
// client the API wrote through. Used only to clear mustChangePassword, which no endpoint
// exposes — smoke-account-deletion.mjs does the same, for the same reason.
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const BASE = process.env.API_URL || "http://localhost:4000/api";
const SEED_PW = process.env.SEED_PASSWORD || "password123";
const TAG = `tt${Date.now()}`;
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

console.log("\n--- guards ---");
check("anonymous cannot list rooms", (await call("/timetabling/rooms")).status === 401);
check("anonymous cannot read a timetable", (await call("/my-timetable?from=2026-09-01&to=2026-09-07")).status === 401);

// A lecturer with NO admin pages. This is the account the whole feature is for, and
// the one that must be refused by the planner.
const lecturerEmail = `${TAG}.lecturer@edtech.co.uk`;
const lecturer = (await call("/staff", { method: "POST", token: admin.token, body: { name: `Zed ${TAG}`, email: lecturerEmail, password: "LecturerPass123!" } })).data;
// No endpoint clears this — a newly created account is forced to change its password
// before it can do anything, which would block every assertion below.
await db.staff.update({ where: { id: lecturer.id }, data: { mustChangePassword: false } });
const lecturerToken = (await call("/auth/login", { method: "POST", body: { email: lecturerEmail, password: "LecturerPass123!" } })).data?.token;
check("the test lecturer could sign in", !!lecturerToken);

// A SECOND lecturer whose name CONTAINS the first's. This pair is the control for
// the assertion that matters most in this suite: "Zed <tag>" is a substring of
// "Zed <tag> Junior", so any name-based match would confuse the two, and an id join
// cannot. Created here rather than later so a twin-owned event can be published
// alongside everything else.
const twinEmail = `${TAG}.twin@edtech.co.uk`;
const twin = (await call("/staff", { method: "POST", token: admin.token, body: { name: `Zed ${TAG} Junior`, email: twinEmail, password: "TwinPass123!" } })).data;
await db.staff.update({ where: { id: twin.id }, data: { mustChangePassword: false } });
const twinToken = (await call("/auth/login", { method: "POST", body: { email: twinEmail, password: "TwinPass123!" } })).data?.token;
check("the twin lecturer could sign in", !!twinToken);

check("a lecturer with no pages is refused by the planner", (await call("/timetabling/rooms", { token: lecturerToken })).status === 403);
check("a lecturer CAN reach their own timetable", (await call("/my-timetable?from=2026-09-01&to=2026-09-07", { token: lecturerToken })).status === 200);

console.log("\n--- rooms ---");
const roomA = (await call("/timetabling/rooms", { method: "POST", token: admin.token, body: { name: `101-${TAG}`, floor: "First floor", campus: "Harrow" } })).data;
check("a room was created", !!roomA?.id);
check("its label reads as the source system's does", roomA?.label === `101-${TAG} - First floor [Harrow]`, roomA?.label);
check("capacity left blank is NULL, not 0", roomA?.capacity === null, String(roomA?.capacity));

const dupSame = await call("/timetabling/rooms", { method: "POST", token: admin.token, body: { name: `101-${TAG}`, campus: "Harrow" } });
check("the same room on the same campus is refused", dupSame.status === 409, String(dupSame.status));
const dupOther = await call("/timetabling/rooms", { method: "POST", token: admin.token, body: { name: `101-${TAG}`, campus: "Great Titchfield Street" } });
check("the SAME room number on another campus is allowed", dupOther.status === 201, String(dupOther.status));

console.log("\n--- events and clash detection ---");
const cat = (await call("/timetabling/categories", { method: "POST", token: admin.token, body: { name: `Lecture-${TAG}`, colour: "#1a3a8f" } })).data;
check("a category was created", !!cat?.id);
check("a non-hex colour is refused", (await call("/timetabling/categories", { method: "POST", token: admin.token, body: { name: `Bad-${TAG}`, colour: "red" } })).status === 400);

const D = "2026-09-01";
const mk = (body) => call("/timetabling/events", { method: "POST", token: admin.token, body });

const e1 = (await mk({ date: D, start: "09:00", end: "11:00", title: `First ${TAG}`, roomId: roomA.id, categoryId: cat.id, staffIds: [lecturer.id] })).data;
check("an event was created", !!e1?.event?.id);
check("the first event has no clashes", e1?.warnings?.length === 0, JSON.stringify(e1?.warnings));

const backToBack = await mk({ date: D, start: "11:00", end: "13:00", title: `Back to back ${TAG}`, roomId: roomA.id });
check("BACK-TO-BACK IN THE SAME ROOM IS NOT A CLASH", backToBack.data?.warnings?.length === 0, JSON.stringify(backToBack.data?.warnings));

const roomClash = await mk({ date: D, start: "10:00", end: "12:00", title: `Overlap ${TAG}`, roomId: roomA.id });
check("a genuine room double-booking IS reported", !!roomClash.data?.warnings?.some((w) => w.kind === "room"));
check("and it was still saved — a warning, not a block", !!roomClash.data?.event?.id);

const staffClash = await mk({ date: D, start: "10:00", end: "12:00", title: `Staff clash ${TAG}`, staffIds: [lecturer.id] });
check("a staff double-booking is reported", !!staffClash.data?.warnings?.some((w) => w.kind === "staff"));

const twinOnly = await mk({ date: D, start: "15:00", end: "16:00", title: `Twin only ${TAG}`, staffIds: [twin.id] });
check("an event naming ONLY the twin was created", !!twinOnly.data?.event?.id);

const otherDay = await mk({ date: "2026-09-02", start: "09:00", end: "11:00", title: `Other day ${TAG}`, roomId: roomA.id });
check("the same room on a different date is not a clash", otherDay.data?.warnings?.length === 0);

const noResources = await mk({ date: D, start: "09:30", end: "10:30", title: `Unassigned ${TAG}` });
check("an event with no room, staff or group reports no clashes", noResources.data?.warnings?.length === 0, JSON.stringify(noResources.data?.warnings));

console.log("\n--- weekly repeat ---");
// Repeat had no coverage at all in the first pass, and it carried the same nested-
// create defect as POST /events — the call most likely to go wrong quietly, because
// it writes a whole term in one go.
const rptSource = (await mk({ date: "2026-10-06", start: "09:00", end: "11:00", title: `Repeat ${TAG}`, staffIds: [lecturer.id] })).data;
check("a source event for the repeat was created", !!rptSource?.event?.id);
const rpt = await call(`/timetabling/events/${rptSource?.event?.id}/repeat`, { method: "POST", token: admin.token, body: { until: "2026-10-27" } });
check("repeat created the three later weeks", rpt.data?.created === 3, `created ${rpt.data?.created}`);
check("and did NOT re-create the source date", !(rpt.data?.dates || []).includes("2026-10-06"), JSON.stringify(rpt.data?.dates));
const rptList = await call("/timetabling/events?from=2026-10-06&to=2026-10-27", { token: admin.token });
const copies = (rptList.data || []).filter((e) => e.title === `Repeat ${TAG}`);
// If a copy loses its staff, a repeated term belongs to nobody — which is precisely
// what an unstamped nested create would have produced, silently, at term scale.
check("every copy carries the staff assignment", copies.length === 4 && copies.every((e) => (e.staff || []).some((s) => s.id === lecturer.id)), `${copies.length} copies`);

console.log("\n--- an unpublished event is invisible to staff ---");
const mine = await call(`/my-timetable?from=${D}&to=${D}`, { token: lecturerToken });
check("the lecturer sees no DRAFT events, though one names them", (mine.data?.events || []).length === 0, `saw ${(mine.data?.events || []).length}`);

await call("/timetabling/events/publish", { method: "POST", token: admin.token, body: { from: D, to: D, published: true } });
const minePub = await call(`/my-timetable?from=${D}&to=${D}`, { token: lecturerToken });
const titles = (minePub.data?.events || []).map((e) => e.title);
check("once published, the lecturer sees the events naming them", titles.includes(`First ${TAG}`), titles.join(" | "));
check("and NOT the ones that do not name them", !titles.includes(`Back to back ${TAG}`), titles.join(" | "));

console.log("\n--- my timetable is found by id, not by name ---");
// THE ASSERTION THIS WHOLE MODULE EXISTS FOR, and it only discriminates in this
// direction. "Zed <tag>" IS a substring of "Zed <tag> Junior", so a match of the
// form "events whose staff name contains MY name" shows the SENIOR lecturer the
// junior's classes. The reverse is not true, which is why asking whether the JUNIOR
// sees the senior's classes proves nothing — the first draft of this test asked
// exactly that, was run against a deliberately broken name match, and passed.
const seniorSees = (await call(`/my-timetable?from=${D}&to=${D}`, { token: lecturerToken })).data?.events || [];
check("the senior does NOT see the class belonging to their name-alike colleague",
  !seniorSees.some((e) => e.title === `Twin only ${TAG}`), seniorSees.map((e) => e.title).join(" | "));
check("and the junior DOES see it, so the check above is not vacuous",
  ((await call(`/my-timetable?from=${D}&to=${D}`, { token: twinToken })).data?.events || []).some((e) => e.title === `Twin only ${TAG}`));


console.log("\n--- a student token cannot reach the staff timetable ---");
// myTimetable.js's header comment claims this, and a comment asserting a security
// property with no test behind it is exactly the kind of claim that quietly stops
// being true. /api/my-timetable is not in STUDENT_ROUTERS, so the allowlist in
// auth.js refuses it before any route in this module runs — which also means a
// router added tomorrow is closed to students without anyone remembering to close
// it. That is the property being pinned here, not this one endpoint.
const bcrypt = require(`${ROOT}/server/node_modules/bcryptjs`);
const aStudent = await db.student.findFirst({ where: { active: true } });
if (!aStudent) {
  check("a seeded student exists to test the allowlist with", false, "none found");
} else {
  await db.student.update({ where: { id: aStudent.id }, data: { passwordHash: bcrypt.hashSync("StudentPass123!", 10), tokenVersion: 0 } });
  const sTok = (await call("/auth/login", { method: "POST", body: { email: aStudent.email, password: "StudentPass123!" } })).data?.token;
  check("the student signed in (control — without this the next two prove nothing)", !!sTok);
  check("A STUDENT TOKEN IS REFUSED BY THE STAFF TIMETABLE", (await call(`/my-timetable?from=${D}&to=${D}`, { token: sTok })).status === 403);
  check("and by the resource picker too", (await call("/my-timetable/resources?type=room", { token: sTok })).status === 403);
  // Put the seeded student back as it was found. Every seeded student has a null
  // passwordHash on purpose — that is what stops the student app being a back door
  // into the college's data on a fresh install, and leaving one live would undo it.
  await db.student.update({ where: { id: aStudent.id }, data: { passwordHash: null } });
}

console.log("\n--- the resource picker ---");
const rooms = await call("/my-timetable/resources?type=room", { token: lecturerToken });
check("a lecturer can search rooms", rooms.status === 200 && Array.isArray(rooms.data?.results));
const students = await call("/my-timetable/resources?type=student", { token: lecturerToken });
check("students need a search term rather than listing everyone", students.data?.needsQuery === true && students.data?.results?.length === 0);
check("an unknown resource type is refused", (await call("/my-timetable/resources?type=wizards", { token: lecturerToken })).status === 400);

console.log("\n--- settings ---");
const badKey = await call("/timetabling/settings", { method: "PUT", token: admin.token, body: { view: "day", isSuperUser: true, view2: "spiral" } });
// The college-wide half of this response is keyed `institution`; it was `tenant` until
// multi-tenancy was removed and the object was renamed after the concept it outlived.
// Same object, same allowlist. These three assertions are about the allowlist and not
// about tenancy, so they follow the rename rather than being dropped — and the truthiness
// guard on the first one is what stops a future rename passing silently.
check("an unknown settings key is DROPPED, not stored", !!badKey.data?.institution && !("isSuperUser" in badKey.data.institution) && !("view2" in badKey.data.institution), JSON.stringify(badKey.data?.institution));
check("a valid key was kept", badKey.data?.institution?.view === "day");
check("an invalid value for a known key is dropped", (await call("/timetabling/settings", { method: "PUT", token: admin.token, body: { view: "spiral" } })).data?.institution?.view === "day");

await call("/timetabling/settings", { method: "PUT", token: admin.token, body: { notice: { enabled: true, text: "College says" } } });
await call("/my-timetable/settings", { method: "PUT", token: lecturerToken, body: { notice: { enabled: true, text: "I say" }, view: "month" } });
const eff = await call("/my-timetable/settings", { token: lecturerToken });
check("a lecturer's own view overrides the college's", eff.data?.settings?.view === "month", eff.data?.settings?.view);
check("A LECTURER CANNOT REWRITE THE COLLEGE'S NOTICE", eff.data?.settings?.notice?.text === "College says", eff.data?.settings?.notice?.text);

console.log("\n--- date windows ---");
check("a missing date range is refused", (await call("/my-timetable", { token: lecturerToken })).status === 400);
check("an inverted range is refused", (await call("/my-timetable?from=2026-09-30&to=2026-09-01", { token: lecturerToken })).status === 400);
check("an absurdly wide range is refused", (await call("/my-timetable?from=2020-01-01&to=2030-01-01", { token: lecturerToken })).status === 400);

console.log("\n--- deleting a room keeps its classes ---");
const del = await call(`/timetabling/rooms/${roomA.id}`, { method: "DELETE", token: admin.token });
check("the room was deleted", del.status === 200, String(del.status));
check("and it said how many events lost their room", typeof del.data?.eventsLeftWithoutARoom === "number" && del.data.eventsLeftWithoutARoom > 0, String(del.data?.eventsLeftWithoutARoom));
const survivor = await call(`/timetabling/events?from=${D}&to=${D}`, { token: admin.token });
check("the classes that were in it still exist, with no room", (survivor.data || []).some((e) => e.title === `First ${TAG}` && e.room === null));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
