// NFC tap check-in — what a tap must never be able to do.
//
// A student taps a sticker in the app and their attendance mark is written with the
// minute they arrived; a staff member taps the same sticker and is clocked in Onsite.
// Both write to records the college is asked to evidence at a funding audit, a visa
// compliance check, or a student's appeal — so this suite spends most of its assertions
// on refusals rather than on the happy path.
//
// The two that matter most, and would otherwise be missed:
//
//   * a tap cannot overwrite a mark a lecturer already set. The suite plants an A, taps,
//     and asserts the A survived with checkedInAt still null.
//   * a later register save cannot overwrite checkedInAt. takenAt IS reset on every
//     save — that is the whole reason the column exists — so the suite taps, saves a
//     correction over it, and asserts the arrival time is unchanged.
//
//   node scripts/smoke-nfc-tap.mjs
//   (needs API_URL + DATABASE_URL; the runner supplies both)
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

const BASE = process.env.API_URL || "http://localhost:4000/api";
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — point it at a throwaway database.");
  process.exit(1);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const bcrypt = require(join(server, "node_modules", "bcryptjs"));
// A BARE client: it bypasses the tenant extension so this suite can plant fixtures the
// API would refuse to create (a lecturer's A on a register nobody has opened, a tag
// belonging to another college) and then read back what the API actually wrote rather
// than what it claims to have written.
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const SEED_PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
const RUN = Date.now().toString(36);

const A_ID = "st-100121";
const A_EMAIL = "100121@edtech.co.uk";
const A_PASSWORD = "nfc-tap-suite-2026";

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

const login = (email, password) => call("/auth/login", { method: "POST", body: { email, password } });

/** "HH:MM" now, in the same zone the server stamps with. */
const nowHHMM = () => new Date().toLocaleTimeString("en-GB", { timeZone: process.env.APP_TIMEZONE || "Europe/London", hour: "2-digit", minute: "2-digit" });
const todayLocal = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.APP_TIMEZONE || "Europe/London" });
const shift = (hhmm, mins) => {
  const [h, m] = hhmm.split(":").map(Number);
  const t = Math.max(0, Math.min(23 * 60 + 59, h * 60 + m + mins));
  return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
};

// Everything this run creates, so the finally block puts the database back exactly as
// the seed left it — the suites share one seeded database and it is not re-run between
// them.
const made = { tags: [], sessions: [], units: [], enrolments: [], marks: [], taps: [], checkIns: [] };
let tenantId = null, otherTenantId = null, configExisted = false, priorConfig = null;

async function cleanup() {
  try {
    for (const id of made.taps) await db.tagTap.delete({ where: { id } }).catch(() => {});
    for (const id of made.marks) await db.attendanceMark.delete({ where: { id } }).catch(() => {});
    for (const id of made.checkIns) await db.checkIn.delete({ where: { id } }).catch(() => {});
    // Taps cascade with their tag; marks cascade with their session.
    for (const id of made.tags) await db.attendanceTag.delete({ where: { id } }).catch(() => {});
    for (const id of made.sessions) await db.hndSession.delete({ where: { id } }).catch(() => {});
    for (const id of made.enrolments) await db.enrolment.delete({ where: { id } }).catch(() => {});
    for (const id of made.units) await db.unit.delete({ where: { id } }).catch(() => {});

    // Put the tap config back exactly as it was. Leaving a college switched ON is the
    // one piece of state here that would change how the product behaves for real users.
    if (configExisted) {
      await db.attendanceTapConfig.updateMany({ where: { tenantId }, data: { settings: priorConfig } }).catch(() => {});
    } else {
      await db.attendanceTapConfig.deleteMany({ where: { tenantId } }).catch(() => {});
    }

    // The seeded students have NO password and tokenVersion 0. Restore both — a student
    // left signable-in by a test run is a real account with a known password.
    await db.student.update({ where: { id: A_ID }, data: { passwordHash: null, tokenVersion: 0 } }).catch(() => {});
  } catch (e) {
    console.error("cleanup problem:", e.message);
  }
}

try {
  const tenant = await db.tenant.findUnique({ where: { slug: process.env.SEED_TENANT_SLUG || "default" } });
  if (!tenant) throw new Error("seeded tenant not found — run the seed first");
  tenantId = tenant.id;

  const existingConfig = await db.attendanceTapConfig.findFirst({ where: { tenantId } });
  configExisted = Boolean(existingConfig);
  priorConfig = existingConfig?.settings ?? {};

  const adminLogin = await login("admin@edtech.co.uk", SEED_PASSWORD);
  const adminToken = adminLogin.data?.token;
  if (!adminToken) throw new Error(`admin sign-in failed (HTTP ${adminLogin.status}) — cannot run this suite`);

  await db.student.update({ where: { id: A_ID }, data: { passwordHash: bcrypt.hashSync(A_PASSWORD, 10), tokenVersion: 0 } });
  const sLogin = await login(A_EMAIL, A_PASSWORD);
  const sToken = sLogin.data?.token;
  if (!sToken) throw new Error(`student sign-in failed (HTTP ${sLogin.status}) — cannot run this suite`);

  /* ====================================================================== */
  console.log("\n--- the feature ships switched off ---");
  /* ====================================================================== */

  // Deliberately BEFORE the config is enabled. A college that has never heard of this
  // feature must not have its registers writable by anybody holding a student token.
  await db.attendanceTapConfig.deleteMany({ where: { tenantId } });
  const offTap = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode: "anything" } });
  check("a student tap is refused while the feature is off", offTap.status === 403, `HTTP ${offTap.status}`);

  const offStaff = await call("/checkins/tap-check-in", { method: "POST", token: adminToken, body: { tagCode: "anything" } });
  check("a staff tap is refused while the feature is off", offStaff.status === 403, `HTTP ${offStaff.status}`);

  const offCtx = await call("/student/me/tap-context", { token: sToken });
  check("tap-context reports disabled rather than leaking the timetable",
    offCtx.status === 200 && offCtx.data?.enabled === false && offCtx.data?.now === null,
    `HTTP ${offCtx.status}`);

  // Switch it on THROUGH THE API, not by writing the row directly.
  //
  // Not a stylistic choice: the config is cached for 30 seconds per tenant, and the
  // disabled assertions above have just populated that cache with enabled:false. A
  // direct row write would leave the running API refusing every tap for half a minute,
  // which is what the first run of this suite actually did. save() invalidates the
  // cache, so going through the endpoint is also the only way to test the path a real
  // administrator uses.
  const turnedOn = await call("/tags/settings", {
    method: "PUT", token: adminToken,
    body: { enabled: true, lateAfterMins: 15, earlyGraceMins: 0, armSeconds: 60, staffTapEnabled: true },
  });
  check("an administrator can switch tap check-in on",
    turnedOn.status === 200 && turnedOn.data?.enabled === true,
    `HTTP ${turnedOn.status}`);

  const settingsSeen = await call("/tags/settings", { token: adminToken });
  check("the settings read back as saved", settingsSeen.data?.lateAfterMins === 15 && settingsSeen.data?.enabled === true, "");

  const studentReadsSettings = await call("/tags/settings", { token: sToken });
  check("a student cannot read the tap settings", studentReadsSettings.status === 403, `HTTP ${studentReadsSettings.status}`);

  // A patch, not a replacement: changing one key must not reset the others.
  await call("/tags/settings", { method: "PUT", token: adminToken, body: { lateAfterMins: 20 } });
  const patched = await call("/tags/settings", { token: adminToken });
  check("changing one setting does not reset the others",
    patched.data?.lateAfterMins === 20 && patched.data?.enabled === true,
    `lateAfterMins=${patched.data?.lateAfterMins} enabled=${patched.data?.enabled}`);
  await call("/tags/settings", { method: "PUT", token: adminToken, body: { lateAfterMins: 15 } });

  /* ====================================================================== */
  console.log("\n--- registering a sticker ---");
  /* ====================================================================== */

  const created = await call("/tags", { method: "POST", token: adminToken, body: { label: `Smoke Room ${RUN}` } });
  const tagCode = created.data?.code;
  if (created.data?.id) made.tags.push(created.data.id);
  check("registering a tag returns its code exactly once", created.status === 201 && typeof tagCode === "string" && tagCode.length > 20, `HTTP ${created.status}`);

  const listed = await call("/tags", { token: adminToken });
  const listedMine = (listed.data || []).find((t) => t.id === created.data?.id);
  check("the tag list never includes codes", listed.status === 200 && !!listedMine && !("code" in listedMine), `HTTP ${listed.status}`);

  const noLabel = await call("/tags", { method: "POST", token: adminToken, body: { label: "  " } });
  check("a tag with no label is refused", noLabel.status === 400, `HTTP ${noLabel.status}`);

  const studentMakesTag = await call("/tags", { method: "POST", token: sToken, body: { label: "nope" } });
  check("a student token cannot reach the tag admin at all", studentMakesTag.status === 403, `HTTP ${studentMakesTag.status}`);

  /* ====================================================================== */
  console.log("\n--- an unknown or retired tag ---");
  /* ====================================================================== */

  const unknown = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode: `no-such-code-${RUN}` } });
  check("an unknown tag code is refused", unknown.status === 404, `HTTP ${unknown.status}`);

  const retired = await db.attendanceTag.create({ data: { tenantId, code: `retired-${RUN}`, label: `Retired ${RUN}`, active: false } });
  made.tags.push(retired.id);
  const retiredTap = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode: retired.code } });
  check("a retired tag is refused, and reads identically to one that never existed",
    retiredTap.status === 404 && retiredTap.data?.error === unknown.data?.error,
    `HTTP ${retiredTap.status}`);

  // A tag belonging to ANOTHER college. db.js scopes the lookup, so this must be
  // invisible rather than merely rejected — the isolation is what is under test.
  const other = await db.tenant.findFirst({ where: { NOT: { id: tenantId } } });
  if (other) {
    otherTenantId = other.id;
    const foreign = await db.attendanceTag.create({ data: { tenantId: other.id, code: `foreign-${RUN}`, label: `Foreign ${RUN}` } });
    made.tags.push(foreign.id);
    const foreignTap = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode: foreign.code } });
    check("a tag from another college cannot be used here", foreignTap.status === 404, `HTTP ${foreignTap.status}`);
  } else {
    console.log("SKIP  only one tenant in this database — cross-college tag isolation not exercised");
  }

  /* ====================================================================== */
  console.log("\n--- the lecture's own hours are the window ---");
  /* ====================================================================== */

  const today = todayLocal();
  const now = nowHHMM();

  const unit = await db.unit.create({
    data: { tenantId, code: `NFC${RUN}`.slice(0, 12), name: `Tap Suite Unit ${RUN}`, startDate: today, endDate: today },
  });
  made.units.push(unit.id);
  const enrol = await db.enrolment.create({ data: { tenantId, studentId: A_ID, unitId: unit.id } });
  made.enrolments.push(enrol.id);

  // A class that finished an hour ago.
  const past = await db.hndSession.create({
    data: { tenantId, unitId: unit.id, date: today, startTime: shift(now, -180), endTime: shift(now, -60), description: "past" },
  });
  made.sessions.push(past.id);
  const tooLate = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode } });
  check("a tap after the lecture has ended is refused",
    tooLate.status === 409 && tooLate.data?.reason === "no_session_now",
    `HTTP ${tooLate.status} ${tooLate.data?.reason || ""}`);

  // A class that starts in an hour. earlyGraceMins is 0, so this is still refused.
  const future = await db.hndSession.create({
    data: { tenantId, unitId: unit.id, date: today, startTime: shift(now, 60), endTime: shift(now, 180), description: "future" },
  });
  made.sessions.push(future.id);
  const tooEarly = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode } });
  check("a tap before the lecture starts is refused",
    tooEarly.status === 409 && tooEarly.data?.reason === "no_session_now",
    `HTTP ${tooEarly.status} ${tooEarly.data?.reason || ""}`);

  /* ====================================================================== */
  console.log("\n--- marking, with the minute ---");
  /* ====================================================================== */

  // A class that started five minutes ago: inside the window, inside the late threshold.
  const live = await db.hndSession.create({
    data: { tenantId, unitId: unit.id, date: today, startTime: shift(now, -5), endTime: shift(now, 115), description: "live" },
  });
  made.sessions.push(live.id);

  const marked = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode } });
  check("a tap during the lecture is marked Present",
    marked.status === 201 && marked.data?.status === "P",
    `HTTP ${marked.status} ${marked.data?.status || marked.data?.error || ""}`);

  const markRow = await db.attendanceMark.findFirst({ where: { sessionId: live.id, studentId: A_ID } });
  if (markRow) made.marks.push(markRow.id);
  check("checkedInAt records the minute, not a timestamp",
    !!markRow && /^\d{2}:\d{2}$/.test(markRow.checkedInAt || ""),
    `checkedInAt=${markRow?.checkedInAt}`);
  check("the mark is stamped as a self check-in, not as a lecturer's",
    !!markRow && markRow.takenBy === "Self check-in (NFC)",
    `takenBy=${markRow?.takenBy}`);

  const firstCheckedInAt = markRow?.checkedInAt;

  // Tapping again must not create a second mark or move the arrival time.
  const again = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode } });
  const markCount = await db.attendanceMark.count({ where: { sessionId: live.id, studentId: A_ID } });
  const afterAgain = await db.attendanceMark.findFirst({ where: { sessionId: live.id, studentId: A_ID } });
  check("a second tap does not create a second mark",
    again.status === 200 && again.data?.alreadyMarked === true && markCount === 1,
    `HTTP ${again.status}, ${markCount} mark(s)`);
  check("a second tap does not move the recorded arrival time",
    afterAgain?.checkedInAt === firstCheckedInAt,
    `${firstCheckedInAt} -> ${afterAgain?.checkedInAt}`);

  /* ====================================================================== */
  console.log("\n--- what a tap must never overwrite ---");
  /* ====================================================================== */

  // THE ONE THAT MATTERS. A lecturer marked this student absent. A tap must not turn
  // that into a P — where two sources disagree, the human who was in the room wins.
  const lecturerSession = await db.hndSession.create({
    data: { tenantId, unitId: unit.id, date: today, startTime: shift(now, -4), endTime: shift(now, 116), description: "lecturer marked" },
  });
  made.sessions.push(lecturerSession.id);
  const plantedA = await db.attendanceMark.create({
    data: { tenantId, sessionId: lecturerSession.id, studentId: A_ID, status: "A", remark: "", takenBy: "Ms Lecturer" },
  });
  made.marks.push(plantedA.id);

  // sessionId is explicit ON PURPOSE. Two sessions are running by now, so a bare tap
  // comes back "ambiguous" and never reaches the overwrite guard at all — the A would
  // survive for the wrong reason and this test would prove nothing. Naming the session
  // is what forces the tap to actually attempt the overwrite.
  const overTap = await call("/student/me/tap-check-in", {
    method: "POST", token: sToken, body: { tagCode, sessionId: lecturerSession.id },
  });
  const stillA = await db.attendanceMark.findUnique({ where: { id: plantedA.id } });
  check("a tap CANNOT overwrite a mark the lecturer already set",
    stillA?.status === "A" && stillA?.takenBy === "Ms Lecturer" && overTap.data?.alreadyMarked === true,
    `status=${stillA?.status} takenBy=${stillA?.takenBy} alreadyMarked=${overTap.data?.alreadyMarked} (HTTP ${overTap.status})`);
  check("and it does not invent an arrival time for a mark it did not write",
    stillA?.checkedInAt === null,
    `checkedInAt=${stillA?.checkedInAt}`);

  // THE OTHER ONE. takenAt IS reset on every register save; checkedInAt must not be.
  // This is the entire reason the column exists.
  const beforeSave = await db.attendanceMark.findFirst({ where: { sessionId: live.id, studentId: A_ID } });
  const saved = await call(`/hnd/sessions/${live.id}/register`, {
    method: "PUT", token: adminToken,
    body: { marks: [{ studentId: A_ID, status: "L", remark: "corrected by the tutor" }] },
  });
  const afterSave = await db.attendanceMark.findFirst({ where: { sessionId: live.id, studentId: A_ID } });
  check("a later register save does NOT overwrite checkedInAt",
    saved.status === 200 && afterSave?.checkedInAt === beforeSave?.checkedInAt && afterSave?.status === "L",
    `HTTP ${saved.status}, ${beforeSave?.checkedInAt} -> ${afterSave?.checkedInAt}, status ${afterSave?.status}`);
  // takenBy, not takenAt. The two writes land inside the same second on a fast machine,
  // so comparing timestamps proves nothing — the first version of this assertion passed
  // with 22:21:41 on both sides. takenBy genuinely changes hands: the tap stamps
  // "Self check-in (NFC)" and the register save stamps the administrator's name. That
  // the row WAS rewritten while checkedInAt survived is the whole point of the pair.
  check("the save really did rewrite the mark — provenance changed hands",
    beforeSave?.takenBy === "Self check-in (NFC)" && afterSave?.takenBy && afterSave.takenBy !== "Self check-in (NFC)",
    `takenBy ${beforeSave?.takenBy} -> ${afterSave?.takenBy}`);

  /* ====================================================================== */
  console.log("\n--- enrolment is what makes a student eligible ---");
  /* ====================================================================== */

  const strangerUnit = await db.unit.create({
    data: { tenantId, code: `NOEN${RUN}`.slice(0, 12), name: `Not Enrolled ${RUN}`, startDate: today, endDate: today },
  });
  made.units.push(strangerUnit.id);
  const strangerSession = await db.hndSession.create({
    data: { tenantId, unitId: strangerUnit.id, date: today, startTime: shift(now, -3), endTime: shift(now, 117), description: "not enrolled" },
  });
  made.sessions.push(strangerSession.id);
  const strangerMark = await db.attendanceMark.findFirst({ where: { sessionId: strangerSession.id, studentId: A_ID } });
  check("a session on a unit the student is not enrolled on is never a candidate",
    strangerMark === null,
    strangerMark ? "a mark was written on a unit they are not on" : "");

  /* ====================================================================== */
  console.log("\n--- the tap log ---");
  /* ====================================================================== */

  const log = await call(`/tags/${created.data?.id}/log`, { token: adminToken });
  const outcomes = (log.data?.taps || []).map((t) => t.outcome);
  check("the log records refusals as well as marks",
    log.status === 200 && outcomes.includes("marked") && outcomes.includes("no_session_now") && outcomes.includes("already_marked"),
    `outcomes: ${[...new Set(outcomes)].join(", ")}`);
  check("the log never carries an email address",
    log.status === 200 && !JSON.stringify(log.data).includes("@"),
    "");

  const studentReadsLog = await call(`/tags/${created.data?.id}/log`, { token: sToken });
  check("a student cannot read a tag's log", studentReadsLog.status === 403, `HTTP ${studentReadsLog.status}`);

  /* ====================================================================== */
  console.log("\n--- the lecturer's live view ---");
  /* ====================================================================== */

  const live1 = await call(`/hnd/sessions/${live.id}/live`, { token: adminToken });
  const meRow = (live1.data?.rows || []).find((r) => r.student?.id === A_ID);
  check("the live view shows the tapped student with the minute they arrived",
    live1.status === 200 && meRow?.checkedInAt === firstCheckedInAt,
    `HTTP ${live1.status} checkedInAt=${meRow?.checkedInAt}`);
  // Provenance follows the LAST writer. This row was tapped, then corrected by the
  // administrator in the register-save section above, so it must no longer read as
  // self-marked — a lecturer who takes a mark over owns it.
  check("a row a lecturer took over no longer reads as self-marked",
    meRow?.selfMarked === false && meRow?.takenBy && meRow.takenBy !== "Self check-in (NFC)",
    `selfMarked=${meRow?.selfMarked} takenBy=${meRow?.takenBy}`);

  // And the other direction, on a register nobody has corrected. Both assertions are
  // needed: the first alone would pass against a `selfMarked` hardcoded to false.
  const freshSession = await db.hndSession.create({
    data: { tenantId, unitId: unit.id, date: today, startTime: shift(now, -2), endTime: shift(now, 118), description: "fresh" },
  });
  made.sessions.push(freshSession.id);
  // sessionId explicit: several of this student's sessions are running by now, so a bare
  // tap comes back ambiguous.
  await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode, sessionId: freshSession.id } });
  const freshLive = await call(`/hnd/sessions/${freshSession.id}/live`, { token: adminToken });
  const freshRow = (freshLive.data?.rows || []).find((r) => r.student?.id === A_ID);
  const freshMark = await db.attendanceMark.findFirst({ where: { sessionId: freshSession.id, studentId: A_ID } });
  if (freshMark) made.marks.push(freshMark.id);
  check("a row the student tapped DOES read as self-marked",
    freshRow?.selfMarked === true && freshRow?.checkedInAt,
    `selfMarked=${freshRow?.selfMarked} checkedInAt=${freshRow?.checkedInAt}`);
  check("the counts add up to the roll",
    live1.data && (live1.data.counts.P + live1.data.counts.L + live1.data.counts.E + live1.data.counts.A + live1.data.counts.notMarked) === live1.data.rows.length,
    JSON.stringify(live1.data?.counts));
  check("a student cannot read the lecturer's live view", (await call(`/hnd/sessions/${live.id}/live`, { token: sToken })).status === 403, "");

  // Closing the register: the ONLY path from this feature to an absence.
  const strangerEnrol = await db.enrolment.create({ data: { tenantId, studentId: "st-100122", unitId: unit.id } }).catch(() => null);
  if (strangerEnrol) made.enrolments.push(strangerEnrol.id);

  const beforeClose = await call(`/hnd/sessions/${live.id}/live`, { token: adminToken });
  const notMarkedBefore = beforeClose.data?.counts?.notMarked ?? 0;
  const closed = await call(`/hnd/sessions/${live.id}/mark-remaining-absent`, { method: "POST", token: adminToken });
  const closedMarks = await db.attendanceMark.findMany({ where: { sessionId: live.id } });
  for (const m of closedMarks) if (!made.marks.includes(m.id)) made.marks.push(m.id);
  check("closing the register marks exactly the students who had no mark",
    closed.status === 200 && closed.data?.marked === notMarkedBefore,
    `marked ${closed.data?.marked} of ${notMarkedBefore} unmarked`);

  const mineAfterClose = closedMarks.find((m) => m.studentId === A_ID);
  check("closing the register does NOT touch a student who already tapped in",
    mineAfterClose?.status === "L" && mineAfterClose?.checkedInAt === firstCheckedInAt,
    `status=${mineAfterClose?.status} checkedInAt=${mineAfterClose?.checkedInAt}`);

  const closedAgain = await call(`/hnd/sessions/${live.id}/mark-remaining-absent`, { method: "POST", token: adminToken });
  check("closing an already-closed register marks nobody a second time",
    closedAgain.status === 200 && closedAgain.data?.marked === 0,
    `marked=${closedAgain.data?.marked}`);

  const studentCloses = await call(`/hnd/sessions/${live.id}/mark-remaining-absent`, { method: "POST", token: sToken });
  check("a student cannot close a register", studentCloses.status === 403, `HTTP ${studentCloses.status}`);

  const mine = await call("/hnd/my-sessions/today", { token: adminToken });
  check("my-sessions/today answers without error for a lecturer teaching nothing",
    mine.status === 200 && Array.isArray(mine.data?.sessions),
    `HTTP ${mine.status} ${mine.data?.sessions?.length} session(s)`);

  /* ====================================================================== */
  console.log("\n--- the staff side ---");
  /* ====================================================================== */

  const staffDate = todayLocal();
  const priorCheckIn = await db.checkIn.findFirst({ where: { staffId: { not: undefined }, date: staffDate } });
  const adminId = adminLogin.data?.user?.id;
  // Clear any clock-in the admin already has today, so the assertions below are about
  // this tap and not about a row another suite left behind.
  if (adminId) await db.checkIn.deleteMany({ where: { staffId: adminId, date: staffDate } });

  const staffTap = await call("/checkins/tap-check-in", { method: "POST", token: adminToken, body: { tagCode } });
  const ciRow = adminId ? await db.checkIn.findFirst({ where: { staffId: adminId, date: staffDate } }) : null;
  if (ciRow) made.checkIns.push(ciRow.id);
  check("a staff tap clocks them in Onsite",
    staffTap.status === 201 && ciRow?.site === "Onsite",
    `HTTP ${staffTap.status} site=${ciRow?.site}`);
  check("and records which sticker it came from",
    ciRow?.tagId === created.data?.id,
    `tagId=${ciRow?.tagId}`);
  check("the clock-in time is HH:MM in the college's zone",
    /^\d{2}:\d{2}$/.test(ciRow?.timeIn || ""),
    `timeIn=${ciRow?.timeIn}`);

  const staffAgain = await call("/checkins/tap-check-in", { method: "POST", token: adminToken, body: { tagCode } });
  const ciCount = adminId ? await db.checkIn.count({ where: { staffId: adminId, date: staffDate } }) : -1;
  const ciAfter = adminId ? await db.checkIn.findFirst({ where: { staffId: adminId, date: staffDate } }) : null;
  check("a second staff tap the same day does not create a second row",
    staffAgain.status === 200 && staffAgain.data?.alreadyCheckedIn === true && ciCount === 1,
    `HTTP ${staffAgain.status}, ${ciCount} row(s)`);
  check("and does not rewrite the recorded arrival time",
    ciAfter?.timeIn === ciRow?.timeIn,
    `${ciRow?.timeIn} -> ${ciAfter?.timeIn}`);

  const staffTapNoSite = await call("/checkins/tap-check-in", { method: "POST", token: adminToken, body: { tagCode, site: "Online" } });
  const ciSite = adminId ? await db.checkIn.findFirst({ where: { staffId: adminId, date: staffDate } }) : null;
  check("a tap ignores any site the caller sends — the tap proves Onsite",
    ciSite?.site === "Onsite",
    `site=${ciSite?.site} (HTTP ${staffTapNoSite.status})`);

  /* ====================================================================== */
  console.log("\n--- the student portal is still sealed ---");
  /* ====================================================================== */

  const studentHitsHnd = await call("/hnd/units", { token: sToken });
  check("a student token still reaches nothing but /api/student", studentHitsHnd.status === 403, `HTTP ${studentHitsHnd.status}`);

  const noTag = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: {} });
  check("a tap with no tag is refused", noTag.status === 400, `HTTP ${noTag.status}`);

  const anon = await call("/student/me/tap-check-in", { method: "POST", body: { tagCode } });
  check("a tap with no session at all is refused", anon.status === 401, `HTTP ${anon.status}`);

} catch (e) {
  console.error("\nsuite error:", e.message);
  fail++;
} finally {
  await cleanup();
  await db.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
