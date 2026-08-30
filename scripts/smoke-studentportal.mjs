// The student portal — /api/student and the admin half of Student Queries.
//
// This is the only part of the product a student ever touches, and it is the part
// where a mistake is worst: every route here serves ONE person's record, and the
// router next door serves everybody's. Two things therefore have to be true at once
// and are what this suite spends its assertions on —
//
//   1. a student session can reach nothing but /api/student, and
//   2. inside /api/student, a student sees their OWN row and nobody else's.
//
// Beyond isolation it pins the numbers a student is shown. Attendance percentages and
// assessment bands are the figures a college defends at an appeal or reports to a
// funding body; if the weighting drifts, or an untaken register starts counting as an
// absence, nobody notices until a student is told they are below 80% and they are not.
//
//   node scripts/smoke-studentportal.mjs
//   (needs API_URL + DATABASE_URL; the runner supplies both)
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

// API_URL, not API_BASE — the runner sets API_URL and the port moves per suite.
const BASE = process.env.API_URL || "http://localhost:4000/api";
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — point it at a throwaway database.");
  process.exit(1);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const bcrypt = require(join(server, "node_modules", "bcryptjs"));
// A BARE client, so this suite can plant fixtures
// (a rival student's query, a mark above its assessment maximum, a draft timetable
// row) that the API itself would refuse to create, and then read back what the API
// actually wrote rather than what it claims to have written.
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const SEED_PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
const RUN = Date.now().toString(36);

// The student under test and their neighbour. A is enrolled on m-obm / m-ws / m-bs and
// deliberately NOT on m-dito; B is on m-dito and not on m-bs. Every "can A see B's
// data" assertion below leans on that asymmetry.
const A_ID = "st-100121";           // Mubarak Ali
const B_ID = "st-100140";           // Tobias Lindqvist
const A_EMAIL = "100121@edtech.co.uk";
const A_PASSWORD = "student-portal-suite-2026";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function call(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  return { status: res.status, data };
}

const login = async (email, password) => {
  const r = await call("/auth/login", { method: "POST", body: { email, password } });
  return r;
};

// The attendance model the whole college is measured against: P=2, L=1, E=1, A=0,
// over the sessions actually marked. Recomputed here from raw rows so the suite is
// checking the RULE, not re-running the server's own helper.
const POINTS = { P: 2, L: 1, E: 1, A: 0 };
function expectedSummary(marks) {
  let earned = 0, marked = 0;
  for (const m of marks) { if (!(m.status in POINTS)) continue; marked++; earned += POINTS[m.status]; }
  const possible = marked * 2;
  return { marked, earned, possible, pct: possible > 0 ? Math.round((earned / possible) * 1000) / 10 : null };
}

// Everything this run creates, so the finally block can put the database back exactly
// as the seed left it — eight suites share one seeded database and the seed is not
// re-run between them.
const made = { queries: [], reviews: [], assessments: [], slots: [], units: [], courses: [], enrolments: [] };

async function cleanup() {
  try {
    for (const id of made.queries) await db.studentQuery.delete({ where: { id } }).catch(() => {});
    for (const id of made.reviews) await db.studentReview.delete({ where: { id } }).catch(() => {});
    // Grades cascade with their assessment.
    for (const id of made.assessments) await db.assessment.delete({ where: { id } }).catch(() => {});
    for (const id of made.slots) await db.timetableSlot.delete({ where: { id } }).catch(() => {});
    for (const id of made.enrolments) await db.enrolment.delete({ where: { id } }).catch(() => {});
    for (const id of made.units) await db.unit.delete({ where: { id } }).catch(() => {});
    for (const id of made.courses) await db.course.delete({ where: { id } }).catch(() => {});
    // The seeded students have NO password and tokenVersion 0. Restore both — a
    // student left signable-in by a test run is a real account with a known password.
    await db.student.update({ where: { id: A_ID }, data: { passwordHash: null, tokenVersion: 0 } }).catch(() => {});
  } catch (e) {
    console.error("cleanup problem:", e.message);
  }
}

try {
  console.log("\n--- a seeded student has no way in until the college gives them one ---");
  // Every seeded student has passwordHash null. That is the whole reason the student
  // app is not a back door into the college's data on a fresh install: the records
  // exist, the logins do not. If this ever returns a token, ten real students are
  // reachable by anyone who can guess the email pattern.
  const noPw = await login("100122@edtech.co.uk", "anything-at-all-2026");
  check("a student with no password cannot sign in", noPw.status === 401, `HTTP ${noPw.status}`);

  await db.student.update({ where: { id: A_ID }, data: { passwordHash: bcrypt.hashSync(A_PASSWORD, 10), tokenVersion: 0 } });

  const sLogin = await login(A_EMAIL, A_PASSWORD);
  const sToken = sLogin.data?.token;
  check("the student signs in and gets a student-kind session",
    sLogin.status === 200 && !!sToken && sLogin.data?.user?.kind === "student" && sLogin.data?.user?.studentRef === "100121",
    `HTTP ${sLogin.status}`);

  const adminLogin = await login("admin@edtech.co.uk", SEED_PASSWORD);
  const staffLogin = await login("j.whitfield@edtech.co.uk", SEED_PASSWORD);
  const adminToken = adminLogin.data?.token, staffToken = staffLogin.data?.token;
  check("admin and staff sign in (fixtures for the negative tests)", !!adminToken && !!staffToken);

  console.log("\n--- the allowlist: a student token reaches /api/student and nothing else ---");
  // requireAuth's STUDENT_ROUTERS allowlist is one line of code standing between a
  // student and every staff surface in the product. Three different shapes of staff
  // data, all of which a student app could plausibly be pointed at by mistake.
  const toStaff = await call("/staff", { token: sToken });
  check("student token refused by the staff roster", toStaff.status === 403 && /student accounts/i.test(toStaff.data?.error || ""), `HTTP ${toStaff.status}`);
  check("...and it returned no staff rows", !Array.isArray(toStaff.data));

  const toHnd = await call("/hnd/sessions?unitId=m-obm", { token: sToken });
  check("student token refused by the registers router", toHnd.status === 403, `HTTP ${toHnd.status}`);

  // The sharpest one: this is the ADMIN side of the student's own queries. It looks
  // like "their" data, so it is the router most likely to be quietly widened one day —
  // and it lists every other student's messages to the college.
  const toQueriesAdmin = await call("/student-queries", { token: sToken });
  check("student token refused by the admin Student Queries router", toQueriesAdmin.status === 403, `HTTP ${toQueriesAdmin.status}`);

  console.log("\n--- and the reverse: staff cannot enter the student portal ---");
  // The two worlds don't cross. An admin reading /student/me would silently 404 or,
  // worse, resolve req.user.id against the Student table and return a stranger.
  const adminIntoPortal = await call("/student/me", { token: adminToken });
  check("an admin token is refused by the student portal", adminIntoPortal.status === 403 && /Student access required/i.test(adminIntoPortal.data?.error || ""), `HTTP ${adminIntoPortal.status}`);
  const anon = await call("/student/me");
  check("no token at all is 401, not 403", anon.status === 401, `HTTP ${anon.status}`);

  console.log("\n--- the student's own profile ---");
  const me = await call("/student/me", { token: sToken });
  const dbEnrolments = (await db.enrolment.findMany({ where: { studentId: A_ID } })).map((e) => e.unitId).sort();
  check("GET /me returns this student", me.status === 200 && me.data?.id === A_ID && me.data?.studentRef === "100121", `HTTP ${me.status}`);
  // A serializer that leaks the hash turns a read endpoint into an offline cracking
  // target, and this one is reachable by the least-trusted account type in the system.
  check("the profile carries no password material", !("passwordHash" in (me.data || {})) && !JSON.stringify(me.data || {}).toLowerCase().includes("password"));
  check("unitIds are exactly the student's enrolments", JSON.stringify((me.data?.unitIds || []).slice().sort()) === JSON.stringify(dbEnrolments), dbEnrolments.join(","));

  console.log("\n--- attendance: the figures a student is judged on ---");
  const att = await call("/student/me/attendance", { token: sToken });
  const rows = [...(att.data?.current || { units: [] }).units, ...(att.data?.previous || [])];
  const rowIds = rows.map((r) => r.unit.id).sort();
  check("attendance covers exactly the enrolled units", att.status === 200 && JSON.stringify(rowIds) === JSON.stringify(dbEnrolments), rowIds.join(","));
  // m-dito is another cohort's unit. Its register holds seven other students' marks.
  check("a unit the student is NOT enrolled on is absent", !rowIds.includes("m-dito"));

  // Recompute every unit's figure from the raw marks and compare. This is the
  // assertion that catches a change to the points model, to the rounding, or to the
  // join between marks and sessions — none of which announce themselves.
  let weightingOk = true, weightDetail = "";
  for (const r of rows) {
    const sessions = await db.hndSession.findMany({ where: { unitId: r.unit.id }, select: { id: true } });
    const ids = sessions.map((s) => s.id);
    const marks = await db.attendanceMark.findMany({ where: { studentId: A_ID, sessionId: { in: ids } }, select: { status: true } });
    const want = expectedSummary(marks);
    const got = r.summary;
    if (got.marked !== want.marked || got.earned !== want.earned || got.possible !== want.possible || got.pct !== want.pct) {
      weightingOk = false;
      weightDetail = `${r.unit.code}: got ${got.pct}% (${got.earned}/${got.possible}) want ${want.pct}% (${want.earned}/${want.possible})`;
    }
  }
  check("every unit's percentage matches P=2 L=1 E=1 A=0 over marked sessions", weightingOk, weightDetail);

  // The Workshop unit has 8 sessions but only 5 taken registers — today's is
  // deliberately blank and two are in the future. If untaken registers counted, a
  // student would be shown an attendance figure lower than anything they did wrong,
  // and would be chased (or reported to UKVI) for a register a lecturer forgot.
  const ws = rows.find((r) => r.unit.id === "m-ws");
  const wsSessions = await db.hndSession.count({ where: { unitId: "m-ws" } });
  const wsMarks = await db.attendanceMark.count({ where: { studentId: A_ID, session: { unitId: "m-ws" } } });
  check("untaken and future registers are excluded from the denominator",
    !!ws && ws.summary.marked === wsMarks && wsMarks < wsSessions,
    `marked ${ws?.summary?.marked} of ${wsSessions} sessions`);

  // Seeded units are unscheduled and their last session is a fortnight AHEAD, so
  // nothing has finished. A unit dropping into "previous" early is how a student
  // loses sight of the course they are currently on.
  check("a unit whose last session is still ahead is not filed as finished",
    Array.isArray(att.data?.previous) && att.data.previous.length === 0,
    `${att.data?.previous?.length} in previous`);

  // Installed app builds predate the Course→Unit rename and read the OLD keys. This
  // alias is the only reason those phones keep working without a reinstall — it is a
  // contract with software already in students' pockets, not tidy-up-able.
  const first = att.data?.current?.units?.[0];
  check("the module/modules back-compat aliases are still sent",
    Array.isArray(att.data?.current?.modules) &&
    att.data.current.modules.length === att.data.current.units.length &&
    !!first?.module && first.module.id === first.unit.id);

  console.log("\n--- assessments: marks, bands and the average ---");
  const mkAssessment = async (unitId, title, maxMarks) => {
    const a = await db.assessment.create({ data: { unitId, title, type: "Assignment", maxMarks, weight: 25, dueDate: "2026-05-01" } });
    made.assessments.push(a.id);
    return a;
  };
  const grade = async (assessmentId, marks) => db.assessmentGrade.create({ data: { assessmentId, studentId: A_ID, marks, feedback: "seen", gradedBy: "HR Administrator" } });

  const aDist = await mkAssessment("m-obm", `SP Distinction ${RUN}`, 100);
  const aFail = await mkAssessment("m-obm", `SP Fail ${RUN}`, 100);
  const aUngraded = await mkAssessment("m-obm", `SP Ungraded ${RUN}`, 100);
  const aLegacy = await mkAssessment("m-obm", `SP Legacy ${RUN}`, 50);
  // On a unit A is not enrolled on. Another cohort's paper, another cohort's mark.
  const aOther = await mkAssessment("m-dito", `SP Other cohort ${RUN}`, 100);

  await grade(aDist.id, 70);   // exactly on the Distinction boundary
  await grade(aFail.id, 49);   // one mark below Pass
  await grade(aLegacy.id, 60); // a historic mark ABOVE its maximum — see below
  await db.assessmentGrade.create({ data: { assessmentId: aOther.id, studentId: B_ID, marks: 100 } });

  const asr = await call("/student/me/assessments", { token: sToken });
  const items = asr.data?.assessments || [];
  const byId = new Map(items.map((i) => [i.id, i]));
  check("assessments load", asr.status === 200 && items.length === 4, `HTTP ${asr.status}, ${items.length} items`);
  check("an assessment on a unit the student is not enrolled on is invisible", !byId.has(aOther.id));

  // The band boundaries are published to students in the handbook and repeated in
  // three places in this codebase. 70 must be a Distinction and 49 must not be a Pass;
  // an off-by-one here is an appeal the college loses.
  check("70/100 is exactly a Distinction", byId.get(aDist.id)?.pct === 70 && byId.get(aDist.id)?.grade === "Distinction", `${byId.get(aDist.id)?.pct}% ${byId.get(aDist.id)?.grade}`);
  check("49/100 is a Fail, not a Pass", byId.get(aFail.id)?.pct === 49 && byId.get(aFail.id)?.grade === "Fail", `${byId.get(aFail.id)?.pct}% ${byId.get(aFail.id)?.grade}`);
  // Data migrated from a previous system routinely carries marks above the maximum
  // someone later reduced. Showing a student "120%" destroys confidence in every
  // other number on the screen.
  check("a mark above its maximum is clamped to 100%, never 120%", byId.get(aLegacy.id)?.pct === 100, `${byId.get(aLegacy.id)?.pct}%`);
  // An unmarked piece of work must read as unmarked, not as zero — a null that turns
  // into a 0 drags the average down and tells the student they failed something
  // nobody has looked at yet.
  const ung = byId.get(aUngraded.id);
  check("work not yet marked shows as unmarked, not as zero", ung?.marks === null && ung?.pct === null && ung?.grade === null, `marks=${ung?.marks} pct=${ung?.pct}`);
  check("the average counts only graded work", asr.data?.graded === 3 && asr.data?.averagePct === 73 && asr.data?.averageGrade === "Distinction",
    `graded=${asr.data?.graded} avg=${asr.data?.averagePct} ${asr.data?.averageGrade}`);

  console.log("\n--- queries: what the student sends, and what comes back ---");
  const tooShort = await call("/student/me/query", { method: "POST", token: sToken, body: { message: "hi" } });
  check("a two-character query is rejected", tooShort.status === 400, `HTTP ${tooShort.status}`);
  const tooLong = await call("/student/me/query", { method: "POST", token: sToken, body: { message: "x".repeat(4001) } });
  check("a message over 4000 characters is rejected", tooLong.status === 400, `HTTP ${tooLong.status}`);
  // The subject cap exists because subject lands in StudentQuery AND in a notification
  // row for every administrator — an uncapped field is a one-request way to bloat the
  // admin's notification list and their inbox.
  const bigSubject = await call("/student/me/query", { method: "POST", token: sToken, body: { subject: "s".repeat(201), message: "A perfectly reasonable question about my timetable." } });
  check("a subject over 200 characters is rejected", bigSubject.status === 400, `HTTP ${bigSubject.status}`);
  // A number is not a string: without the typeof guard this would be stored raw.
  const wrongType = await call("/student/me/query", { method: "POST", token: sToken, body: { message: 12345 } });
  check("a non-string message is rejected rather than stored", wrongType.status === 400, `HTTP ${wrongType.status}`);

  const created = await call("/student/me/query", { method: "POST", token: sToken, body: { message: `Suite query ${RUN} — when does term end?` } });
  if (created.data?.id) made.queries.push(created.data.id);
  check("a valid query is created open, with the default subject",
    created.status === 201 && created.data?.status === "open" && created.data?.subject === "Student query" && created.data?.studentId === A_ID,
    `HTTP ${created.status}`);

  // Another student's message to the college — welfare, finance, a complaint about a
  // lecturer. The single most private thing in this table.
  const bQuery = await db.studentQuery.create({ data: { studentId: B_ID, subject: `B private ${RUN}`, message: "Confidential message from another student", status: "open" } });
  made.queries.push(bQuery.id);
  const mine = await call("/student/me/queries", { token: sToken });
  check("the query list contains only this student's messages",
    mine.status === 200 && (mine.data || []).every((q) => q.studentId === A_ID) && !JSON.stringify(mine.data || []).includes(`B private ${RUN}`),
    `${(mine.data || []).length} rows`);

  console.log("\n--- the admin half: replying, and who may do it ---");
  const emptyReply = await call(`/student-queries/${created.data.id}/respond`, { method: "PUT", token: adminToken, body: { response: "   " } });
  check("an empty reply is refused", emptyReply.status === 400, `HTTP ${emptyReply.status}`);
  // A plain STAFF account is not an administrator. Student queries are read on a
  // page-gated tab precisely because their contents are not for the whole staff room.
  const staffReply = await call("/student-queries", { token: staffToken });
  check("a non-admin staff account cannot read student queries", staffReply.status === 403, `HTTP ${staffReply.status}`);

  const answer = `Term ends on the 12th. — reply ${RUN}`;
  const replied = await call(`/student-queries/${created.data.id}/respond`, { method: "PUT", token: adminToken, body: { response: answer } });
  check("an admin can answer", replied.status === 200 && replied.data?.status === "answered" && replied.data?.respondedBy === "HR Administrator", `HTTP ${replied.status}`);
  const after = await call("/student/me/queries", { token: sToken });
  const answered = (after.data || []).find((q) => q.id === created.data.id);
  check("the reply reaches the student's app", answered?.response === answer && answered?.status === "answered" && !!answered?.respondedAt);

  console.log("\n--- progress reviews: read-only, and only your own ---");
  const rA1 = await db.studentReview.create({ data: { studentId: A_ID, unitId: "m-obm", staffId: "s2", staffName: "Aisha Rahman", date: "2026-03-01", progress: "On Track", concerns: JSON.stringify(["Attendance", "Engagement"]), summary: "Good progress", agreedActions: "Keep going", followUp: false } });
  // concerns is a JSON string in a plain text column. A row written by an older build,
  // a partial import or a hand edit must render as "no concerns", not as a 500 that
  // takes the student's whole reviews screen down.
  const rA2 = await db.studentReview.create({ data: { studentId: A_ID, unitId: "m-bs", staffId: "s1", staffName: "James Whitfield", date: "2026-02-01", progress: "Monitor", concerns: "{{ not json", summary: "Watch this", agreedActions: "", followUp: true, followUpDate: "2026-04-01" } });
  const rB = await db.studentReview.create({ data: { studentId: B_ID, unitId: "m-obm", staffId: "s2", staffName: "Aisha Rahman", date: "2026-03-02", progress: "At Risk", concerns: "[]", summary: `B only ${RUN}`, agreedActions: "", followUp: false } });
  made.reviews.push(rA1.id, rA2.id, rB.id);

  const revs = await call("/student/me/reviews", { token: sToken });
  const list = revs.data || [];
  check("reviews are scoped to this student", revs.status === 200 && list.length === 2 && !JSON.stringify(list).includes(`B only ${RUN}`), `${list.length} rows`);
  const got1 = list.find((r) => r.id === rA1.id);
  // The author's name is copied onto the row so a review still says who wrote it after
  // that lecturer leaves — a pastoral record with no author is not evidence of anything.
  check("concerns parse to an array and the author is kept",
    Array.isArray(got1?.concerns) && got1.concerns.length === 2 && got1.staffName === "Aisha Rahman",
    JSON.stringify(got1?.concerns));
  const got2 = list.find((r) => r.id === rA2.id);
  check("a corrupt concerns field degrades to an empty list, not a 500", Array.isArray(got2?.concerns) && got2.concerns.length === 0);

  console.log("\n--- timetable: drafts stay private until they are published ---");
  // Seeded units carry no course/year/term, so the student sits in no stage at all.
  // The right answer is an empty timetable, not a crash on the null.
  const ttEmpty = await call("/student/me/timetable", { token: sToken });
  check("an unclassified student gets an empty timetable, not an error", ttEmpty.status === 200 && Array.isArray(ttEmpty.data?.stages) && ttEmpty.data.stages.length === 0, `HTTP ${ttEmpty.status}`);

  const course = await db.course.create({ data: { name: `SP Course ${RUN}`, colour: "#1a3a8f" } });
  made.courses.push(course.id);
  const ttUnit = await db.unit.create({ data: { id: `sp-unit-${RUN}`, code: `SPU${RUN}`, name: "Suite Timetabled Unit", tutor: "Aisha Rahman", courseId: course.id, year: 1, termNumber: 2, startDate: "2026-01-05", endDate: "2026-04-10" } });
  made.units.push(ttUnit.id);
  const enrol = await db.enrolment.create({ data: { studentId: A_ID, unitId: ttUnit.id } });
  made.enrolments.push(enrol.id);
  const publishedSlot = await db.timetableSlot.create({ data: { courseId: course.id, year: 1, termNumber: 2, unitId: ttUnit.id, day: 1, startTime: "10:00", endTime: "13:00", title: `SP Published ${RUN}`, lecturer: "Aisha Rahman", room: "Room 101", published: true } });
  const draftSlot = await db.timetableSlot.create({ data: { courseId: course.id, year: 1, termNumber: 2, day: 3, startTime: "09:00", endTime: "11:00", title: `SP Draft ${RUN}`, lecturer: "TBC", room: "TBC", published: false } });
  made.slots.push(publishedSlot.id, draftSlot.id);

  const tt = await call("/student/me/timetable", { token: sToken });
  const stage = (tt.data?.stages || [])[0];
  check("the student's stage appears once published",
    tt.status === 200 && (tt.data?.stages || []).length === 1 && stage?.year === 1 && stage?.termNumber === 2 && stage?.courseId === course.id,
    `${(tt.data?.stages || []).length} stages`);
  // A timetable is built over days and edited while it is wrong. A student who sees a
  // draft turns up to a room that was never booked — the reason `published` exists.
  check("an unpublished draft row is not shown to the student",
    stage?.rows?.length === 1 && stage.rows[0].title === `SP Published ${RUN}` && !JSON.stringify(tt.data).includes(`SP Draft ${RUN}`),
    `${stage?.rows?.length} rows`);

  console.log("\n--- session revocation ---");
  // tokenVersion is bumped by a password change and by the student deleting their app
  // account. If an issued token survived that, "sign out everywhere" would be a lie
  // and a stolen phone would keep its session after a reset.
  await db.student.update({ where: { id: A_ID }, data: { tokenVersion: { increment: 1 } } });
  const dead = await call("/student/me", { token: sToken });
  check("bumping tokenVersion kills every issued session", dead.status === 401 && /sign in again/i.test(dead.data?.error || ""), `HTTP ${dead.status}`);
} finally {
  await cleanup();
  await db.$disconnect();
  console.log("\ncleanup: suite fixtures removed, st-100121 password cleared");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
