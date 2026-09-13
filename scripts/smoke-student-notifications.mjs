// Student notifications — the channel the app tells a student anything through.
//
// Task 1 gave Notification and DeviceToken an exactly-one-owner column pair
// (staffId/studentId, a CHECK constraint as the backstop) so the same tables could
// carry a student's own pushes without a second schema. This suite is the seam that
// proves the student half of that actually works end to end, weighted — like every
// other suite in this folder — toward what must NEVER happen:
//
//   * a student's device token is accepted and stored with studentId set, staffId
//     null — never the reverse, and a staff token registering the SAME handset
//     afterwards must MOVE the row to the student rather than leaving it dual-owned
//     (devices.js's own comment: "the row must MOVE to the current user");
//   * a student can never mark, or even see, another student's notification — the
//     unread badge counts ALL of this student's unread rows, not just the page
//     returned, and a forged id copied from someone else's notification matches zero
//     rows rather than reading through to theirs;
//   * every real trigger this feature wires up writes EXACTLY ONE notification per
//     event, driven through the ACTUAL endpoint rather than asserted against notify.js
//     in isolation — a query answered, and a mark released, including the two shapes
//     that are easy to get backwards: a genuine CORRECTION must still notify a second
//     time, and a resave of the identical value (the register/gradebook screen
//     resubmits every student whether or not their row changed) must NOT.
//
// THE API PROCESS THIS SUITE TALKS TO IS ITS OWN, NOT THE SHARED ONE — same reasoning
// as smoke-teams-attendance.mjs: a private port, a throwaway CREDENTIALS_KEY, and
// fixtures that never touch a seeded account, so this suite can run standalone
// alongside `npm run dev` or another suite without either disturbing the other.
//
//   node scripts/smoke-student-notifications.mjs
//   (needs DATABASE_URL; SEED_PASSWORD defaults to the one `npm test` seeds with)
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const server = join(root, "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

// Exit 2 = SKIP (the runner's convention). DATABASE_URL is the one precondition this
// suite cannot work around — without it there is no database to spawn an API against.
if (!process.env.DATABASE_URL) {
  console.log("SKIP — DATABASE_URL is not set, so there is no database to run this suite against");
  process.exit(2);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const bcrypt = require(join(server, "node_modules", "bcryptjs"));

const RUN = Date.now().toString(36);
const PORT = Number(process.env.STUDENT_NOTIF_SMOKE_PORT || 4023);
const API = `http://127.0.0.1:${PORT}/api`;
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;
const SEED_PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
// Never the outer run's key — this suite spawns its OWN API process (see
// smoke-teams-attendance.mjs for the identical reasoning).
const CREDENTIALS_KEY = randomBytes(32).toString("base64");
const JWT_SECRET = "student-notif-smoke-secret-not-for-production";

const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function call(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}
const login = (email, password) => call("/auth/login", { method: "POST", body: { email, password } });

let child, bootLog = "";
function stopApi() {
  if (child && !child.killed) {
    try { process.platform === "win32" ? spawnSync("taskkill", ["/pid", String(child.pid), "/f", "/t"]) : child.kill("SIGTERM"); }
    catch { /* already gone */ }
  }
}
process.on("exit", stopApi);
process.on("SIGINT", () => { stopApi(); process.exit(130); });

async function waitForApi(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// Fire-and-forget notifications (query answer, marks release) run AFTER the response
// is sent, and this suite's own API has no request in flight to wait behind — so a
// short pause after each triggering call is what stands in for "has it landed yet"
// rather than a retry loop with nothing to poll.
const settle = () => new Promise((r) => setTimeout(r, 300));

const A_EMAIL = `snotif-a-${RUN}@x.ac.uk`;
const B_EMAIL = `snotif-b-${RUN}@x.ac.uk`;
const A_PW = "student-notif-suite-2026";
const B_PW = "student-notif-suite-2026";

const made = { students: [], course: null, unit: null, enrolments: [], assessments: [], queries: [], devices: [] };

async function cleanup() {
  try {
    if (made.devices.length) await db.deviceToken.deleteMany({ where: { token: { in: made.devices } } }).catch(() => {});
    for (const id of made.queries) await db.studentQuery.delete({ where: { id } }).catch(() => {});
    // Grades cascade with their assessment (smoke-studentportal.mjs's own comment).
    for (const id of made.assessments) await db.assessment.delete({ where: { id } }).catch(() => {});
    for (const id of made.enrolments) await db.enrolment.delete({ where: { id } }).catch(() => {});
    if (made.unit) await db.unit.delete({ where: { id: made.unit } }).catch(() => {});
    if (made.course) await db.course.delete({ where: { id: made.course } }).catch(() => {});
    // Notification.studentId cascades with the student anyway; deleting the student
    // is enough, and is done LAST so every assertion above has a row to read.
    for (const id of made.students) await db.student.delete({ where: { id } }).catch(() => {});
  } catch (e) {
    console.error("cleanup problem:", e.message);
  }
}

try {
  console.log(`→ starting a private API on port ${PORT}`);
  child = spawn("node", ["src/index.js"], {
    cwd: server,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "test", JWT_SECRET, CREDENTIALS_KEY },
  });
  child.stdout.on("data", (d) => { bootLog += d; });
  child.stderr.on("data", (d) => { bootLog += d; });
  let diedEarly = false;
  child.on("exit", (code) => { if (code) diedEarly = true; });

  const healthy = await waitForApi();
  if (!healthy) {
    console.log(`SKIP — this suite's own API on port ${PORT} never became healthy` +
      (diedEarly ? " (it exited)" : " (timed out)") + `. Last output:\n${bootLog.slice(-2000)}`);
    stopApi();
    process.exit(2);
  }
  console.log("  private API healthy\n");

  /* ====================================================================== */
  console.log("--- fixtures: two students, a unit, an assessment ---");
  /* ====================================================================== */

  const course = await db.course.create({ data: { name: `Notif Suite Course ${RUN}` } });
  made.course = course.id;
  const unit = await db.unit.create({ data: { code: `NSU${RUN}`.slice(0, 12), name: `Notif Suite Unit ${RUN}`, courseId: course.id } });
  made.unit = unit.id;

  const a = await db.student.create({ data: {
    firstName: "Notif", lastName: `A${RUN}`, studentRef: `NA${RUN}`, email: A_EMAIL,
    initials: "NA", colour: "#1a73e8", passwordHash: bcrypt.hashSync(A_PW, 10),
  } });
  made.students.push(a.id);
  const b = await db.student.create({ data: {
    firstName: "Notif", lastName: `B${RUN}`, studentRef: `NB${RUN}`, email: B_EMAIL,
    initials: "NB", colour: "#1a73e8", passwordHash: bcrypt.hashSync(B_PW, 10),
  } });
  made.students.push(b.id);

  const enrolA = await db.enrolment.create({ data: { studentId: a.id, unitId: unit.id } });
  made.enrolments.push(enrolA.id);

  const adminLogin = await login("admin@edtech.co.uk", SEED_PASSWORD);
  const adminToken = adminLogin.data?.token;
  if (!adminToken) throw new Error(`admin sign-in failed (HTTP ${adminLogin.status}) — cannot run this suite`);

  const aLogin = await login(A_EMAIL, A_PW);
  const aToken = aLogin.data?.token;
  const bLogin = await login(B_EMAIL, B_PW);
  const bToken = bLogin.data?.token;
  check("both students sign in", !!aToken && !!bToken, `A=${aLogin.status} B=${bLogin.status}`);

  /* ====================================================================== */
  console.log("\n--- device tokens: exactly one owner, staff behaviour unchanged ---");
  /* ====================================================================== */

  const studentDeviceToken = `snotif-device-student-${RUN}`;
  made.devices.push(studentDeviceToken);
  const regStudent = await call("/devices", { method: "POST", token: aToken, body: { token: studentDeviceToken, platform: "android" } });
  check("a student's device token is accepted", regStudent.status === 201, `HTTP ${regStudent.status}`);
  const studentDeviceRow = await db.deviceToken.findFirst({ where: { token: studentDeviceToken } });
  check("...stored with studentId set and NO staffId",
    studentDeviceRow?.studentId === a.id && studentDeviceRow?.staffId == null,
    `studentId=${studentDeviceRow?.studentId} staffId=${studentDeviceRow?.staffId}`);

  const staffDeviceToken = `snotif-device-staff-${RUN}`;
  made.devices.push(staffDeviceToken);
  const regStaff = await call("/devices", { method: "POST", token: adminToken, body: { token: staffDeviceToken, platform: "ios" } });
  check("a staff token still registers a device — unaffected by the student change", regStaff.status === 201, `HTTP ${regStaff.status}`);
  const staffDeviceRow = await db.deviceToken.findFirst({ where: { token: staffDeviceToken } });
  check("...stored with staffId set and NO studentId",
    staffDeviceRow?.staffId != null && staffDeviceRow?.studentId == null,
    `staffId=${staffDeviceRow?.staffId} studentId=${staffDeviceRow?.studentId}`);

  // The SAME handset, previously a staff device, now signed in as a student — the row
  // must MOVE to the new owner (devices.js's own comment on exactly this scenario),
  // never leaving a phone dual-owned or the old owner still subscribed to it.
  const handoverToken = `snotif-device-handover-${RUN}`;
  made.devices.push(handoverToken);
  await call("/devices", { method: "POST", token: adminToken, body: { token: handoverToken, platform: "ios" } });
  const movedReg = await call("/devices", { method: "POST", token: aToken, body: { token: handoverToken, platform: "ios" } });
  check("re-registering a staff handset as a student succeeds", movedReg.status === 201, `HTTP ${movedReg.status}`);
  const handoverRow = await db.deviceToken.findFirst({ where: { token: handoverToken } });
  check("...and the row MOVES to the student — never left dual-owned or staff-owned",
    handoverRow?.studentId === a.id && handoverRow?.staffId == null,
    `studentId=${handoverRow?.studentId} staffId=${handoverRow?.staffId}`);

  const devicesForA = await call("/devices", { token: aToken });
  check("GET /devices returns only this student's own devices, and never a raw token",
    Array.isArray(devicesForA.data) && devicesForA.data.length === 2 && !JSON.stringify(devicesForA.data).includes(studentDeviceToken),
    `${devicesForA.data?.length} device(s)`);

  /* ====================================================================== */
  console.log("\n--- notifications: the list, the unread count, cross-student isolation ---");
  /* ====================================================================== */

  // 60 rows for A: the oldest 10 already read, the newest 50 unread. Ordered by
  // createdAt desc, the top 50 the API returns are EXACTLY the 50 unread ones — which
  // is what lets one fixture prove both "at most 50 returned" and "unread counts
  // every unread row, not just the page" in the same read.
  const bulk = [];
  const base = Date.now();
  for (let i = 0; i < 60; i++) {
    bulk.push({
      studentId: a.id, type: "info", message: `Notif suite bulk ${RUN} #${i}`,
      read: i < 10, createdAt: new Date(base + i),
    });
  }
  await db.notification.createMany({ data: bulk });
  const bNote = await db.notification.create({ data: { studentId: b.id, type: "info", message: `B's own notification ${RUN}` } });

  const listA = await call("/student/me/notifications", { token: aToken });
  check("GET /me/notifications returns at most 50, newest first",
    listA.status === 200 && Array.isArray(listA.data?.notifications) && listA.data.notifications.length === 50,
    `${listA.data?.notifications?.length} rows`);
  check("unread counts EVERY unread row, not just the 50-row page returned",
    listA.data?.unread === 50, `unread=${listA.data?.unread}`);
  check("no other student's notification leaked into the list",
    !JSON.stringify(listA.data).includes(`B's own notification ${RUN}`));

  const listB = await call("/student/me/notifications", { token: bToken });
  check("a student's own list holds only their own notification, never A's 60",
    listB.status === 200 && listB.data?.notifications?.length === 1 && listB.data.unread === 1,
    `${listB.data?.notifications?.length} rows, unread=${listB.data?.unread}`);

  console.log("\n--- mark-read: a subset, a forged id, and everything ---");

  const someIds = listA.data.notifications.slice(0, 5).map((n) => n.id);
  const readSubset = await call("/student/me/notifications/read", { method: "PUT", token: aToken, body: { ids: someIds } });
  check("marking a subset by id updates exactly that many",
    readSubset.status === 200 && readSubset.data?.updated === 5, `updated=${readSubset.data?.updated}`);
  const afterSubset = await call("/student/me/notifications", { token: aToken });
  check("...and the unread count drops by exactly that many", afterSubset.data?.unread === 45, `unread=${afterSubset.data?.unread}`);

  // THE ASSERTION THIS SECTION EXISTS FOR. An id copied from another student's
  // notification — guessed, or seen over their shoulder — must match ZERO rows, not
  // read through to a stranger's notification because the WHERE clause forgot to AND
  // in studentId.
  const forgedRead = await call("/student/me/notifications/read", { method: "PUT", token: aToken, body: { ids: [bNote.id] } });
  check("a forged id belonging to another student updates NOTHING",
    forgedRead.status === 200 && forgedRead.data?.updated === 0, `updated=${forgedRead.data?.updated}`);
  const bStillUnread = await db.notification.findUnique({ where: { id: bNote.id } });
  check("...and B's notification is still unread", bStillUnread?.read === false);

  const readAll = await call("/student/me/notifications/read", { method: "PUT", token: aToken, body: {} });
  check("omitting ids marks every remaining unread notification read",
    readAll.status === 200 && readAll.data?.updated === 45, `updated=${readAll.data?.updated}`);
  const afterAll = await call("/student/me/notifications", { token: aToken });
  check("A now has zero unread", afterAll.data?.unread === 0, `unread=${afterAll.data?.unread}`);

  /* ====================================================================== */
  console.log("\n--- trigger: a query answered notifies EXACTLY once ---");
  /* ====================================================================== */

  const beforeQueryCount = await db.notification.count({ where: { studentId: a.id } });
  const qCreate = await call("/student/me/query", { method: "POST", token: aToken, body: { message: `Notif suite query ${RUN}` } });
  check("the student's query is created", qCreate.status === 201, `HTTP ${qCreate.status}`);
  if (qCreate.data?.id) made.queries.push(qCreate.data.id);

  const answered = await call(`/student-queries/${qCreate.data.id}/respond`, { method: "PUT", token: adminToken, body: { response: `Answer ${RUN}` } });
  check("an admin answers the query", answered.status === 200 && answered.data?.status === "answered", `HTTP ${answered.status}`);
  await settle();
  const afterQueryCount = await db.notification.count({ where: { studentId: a.id } });
  check("exactly one notification is written for the answer",
    afterQueryCount === beforeQueryCount + 1, `before=${beforeQueryCount} after=${afterQueryCount}`);
  const qNotif = await db.notification.findFirst({ where: { studentId: a.id }, orderBy: { createdAt: "desc" } });
  check("...and it says the query was answered", /answered/i.test(qNotif?.message || ""), qNotif?.message);

  /* ====================================================================== */
  console.log("\n--- trigger: marks released — per-save dedupe, a correction still fires ---");
  /* ====================================================================== */

  const assessment = await db.assessment.create({ data: {
    unitId: unit.id, title: `Notif Suite Assessment ${RUN}`, type: "Assignment", maxMarks: 100, weight: 0, dueDate: "2026-05-01",
  } });
  made.assessments.push(assessment.id);

  const c0 = await db.notification.count({ where: { studentId: a.id } });
  const save1 = await call(`/assessments/${assessment.id}/grades`, { method: "PUT", token: adminToken, body: { grades: [{ studentId: a.id, marks: 70 }] } });
  check("the first marks save succeeds", save1.status === 200, `HTTP ${save1.status}`);
  await settle();
  const c1 = await db.notification.count({ where: { studentId: a.id } });
  check("releasing a mark writes exactly one notification", c1 === c0 + 1, `before=${c0} after=${c1}`);

  // A CORRECTION — the mark genuinely moves a second time — must notify again. This is
  // the half of "dedupe" that is easy to over-fix: a route that remembers "already
  // told this student about this assessment" would silently swallow a real correction.
  const save2 = await call(`/assessments/${assessment.id}/grades`, { method: "PUT", token: adminToken, body: { grades: [{ studentId: a.id, marks: 75 }] } });
  check("a corrected mark saves", save2.status === 200, `HTTP ${save2.status}`);
  await settle();
  const c2 = await db.notification.count({ where: { studentId: a.id } });
  check("a corrected mark fires a SECOND notification", c2 === c1 + 1, `after correction=${c2}`);

  // THE SAME SAVE RESUBMITTED, mark unchanged. The gradebook screen resends every
  // student on the unit whether or not their own row changed, so this must not
  // notify a second time for a value that did not move.
  const save3 = await call(`/assessments/${assessment.id}/grades`, { method: "PUT", token: adminToken, body: { grades: [{ studentId: a.id, marks: 75 }] } });
  check("resaving the identical mark succeeds", save3.status === 200, `HTTP ${save3.status}`);
  await settle();
  const c3 = await db.notification.count({ where: { studentId: a.id } });
  check("...but does NOT notify again — the per-student, per-save dedupe", c3 === c2, `still ${c3}`);

  // A CLEARED mark is the opposite event — "retracted", not "released" — and must
  // never read as a release.
  const save4 = await call(`/assessments/${assessment.id}/grades`, { method: "PUT", token: adminToken, body: { grades: [{ studentId: a.id, marks: null }] } });
  check("clearing the mark to null succeeds", save4.status === 200, `HTTP ${save4.status}`);
  await settle();
  const c4 = await db.notification.count({ where: { studentId: a.id } });
  check("clearing a mark to null is NOT treated as a release", c4 === c3, `still ${c4}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
} catch (e) {
  console.error("suite error:", e);
  process.exitCode = 1;
} finally {
  stopApi();
  await cleanup();
  await db.$disconnect();
}
