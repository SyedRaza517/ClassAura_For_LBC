// QR check-in — what a scan must never be able to do.
//
// A lecturer puts a rotating code on the screen; a student scans it and their mark is
// written with the minute they arrived. Attendance is a record the college evidences at
// funding audits and visa checks, so — like the NFC suite beside this one — most of the
// assertions here are refusals. The ones that matter most:
//
//   * a code is bound to ITS session and ITS window: a stale code says "expired", a
//     code from the future or another session says "never ours", and neither marks;
//   * naming the session proves nothing about the person: enrolment, the session's own
//     window and the term lock are all still checked;
//   * a scan never overwrites a lecturer's mark, never writes an A, and cannot move an
//     arrival time once written;
//   * the NFC and QR switches are separate: everything in here runs with NFC tap
//     check-in OFF, which is itself the proof.
//
// Codes are derived locally through the server's own modules (attendanceQr.js,
// secrets.js) under the same CREDENTIALS_KEY the runner hands the API — that is what
// lets this suite hold a code from two windows ago or one window in the future without
// waiting for real time to pass.
//
//   node scripts/smoke-qr-checkin.mjs
//   (needs API_URL + DATABASE_URL + CREDENTIALS_KEY; the runner supplies all three)
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
// Exit 2 = "skipped", which the runner reports as SKIP rather than PASS. Without the
// key this suite cannot derive a single code, and the API it would call cannot sign
// one either — there is nothing to exercise, and pretending otherwise would count as
// coverage. The runner always sets it; only a bare standalone run lands here.
if (!process.env.CREDENTIALS_KEY) {
  console.log("SKIP — CREDENTIALS_KEY is not set, so no code can be derived or verified in this run");
  process.exit(2);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const bcrypt = require(join(server, "node_modules", "bcryptjs"));
const { deriveCode, windowIndexFor, CODE_LENGTH } = require(join(server, "src", "attendanceQr.js"));
const { qrSigningKey } = require(join(server, "src", "secrets.js"));

// A BARE client, not the one the API writes through, so this suite can plant fixtures
// the API would refuse (a lecturer's A, a closed term) and read back what the API
// actually wrote rather than what it claims to have written.
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const SEED_PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
const RUN = Date.now().toString(36);

// The signing key, derived exactly as the API derives it. If these ever disagree the
// happy path below fails immediately, which is the fastest possible detection of a
// derivation drift between suite and server.
const SECRET = qrSigningKey();
const ROTATE = 30;
const codeFor = (sessionId, offsetWindows = 0) =>
  deriveCode({ secret: SECRET, sessionId, windowIndex: windowIndexFor(Math.floor(Date.now() / 1000), ROTATE) + offsetWindows });

// A code derived in the last moments of a window is a DIFFERENT window by the time the
// API reads its own clock — a real race with a thirty-second fuse, and it would make
// the two boundary-sensitive assertions below flake exactly once a month in CI. Waiting
// out the tail of the window costs at most a couple of seconds and makes them
// deterministic.
const avoidBoundary = async () => {
  const into = Math.floor(Date.now() / 1000) % ROTATE;
  if (into >= ROTATE - 2) await new Promise((r) => setTimeout(r, (ROTATE - into + 1) * 1000));
};

// Three seeded students, none of them the ones smoke-nfc-tap signs in. The reason is
// the rate limiter, twice over: the verify route shares the NFC route's budget of ten
// attempts per student per minute, and that Map lives in the API process ACROSS
// suites — a student the NFC suite spent to the ceiling arrives here with nothing
// left. QA spends eight below, QC three, QB two; nobody sits on the ceiling.
const QA_ID = "st-100118";
const QA_EMAIL = "100118@edtech.co.uk";
const QB_ID = "st-100123"; // the term-lock block only
const QB_EMAIL = "100123@edtech.co.uk";
const QC_ID = "st-100129"; // refusals that must not drain QA's budget
const QC_EMAIL = "100129@edtech.co.uk";
const S_PASSWORD = "qr-checkin-suite-2026";

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

const nowHHMM = () => new Date().toLocaleTimeString("en-GB", { timeZone: process.env.APP_TIMEZONE || "Europe/London", hour: "2-digit", minute: "2-digit" });
const todayLocal = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.APP_TIMEZONE || "Europe/London" });
const shift = (hhmm, mins) => {
  const [h, m] = hhmm.split(":").map(Number);
  const t = Math.max(0, Math.min(23 * 60 + 59, h * 60 + m + mins));
  return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
};

// Everything this run creates, so the finally block puts the database back exactly as
// the seed left it — the suites share one seeded database.
const made = { sessions: [], units: [], enrolments: [], marks: [], terms: [], cohorts: [], courses: [] };
let configExisted = false, priorConfig = null;

async function cleanup() {
  try {
    // Every QR tap row these three students produced, including the refusals this
    // suite asserted only by their HTTP answers. Bulk on (student, method) rather
    // than tracked ids because EVERY outcome logs a row and most are never read back.
    await db.tagTap.deleteMany({ where: { studentId: { in: [QA_ID, QB_ID, QC_ID] }, method: "qr" } }).catch(() => {});
    for (const id of made.marks) await db.attendanceMark.delete({ where: { id } }).catch(() => {});
    for (const id of made.sessions) await db.hndSession.delete({ where: { id } }).catch(() => {});
    for (const id of made.enrolments) await db.enrolment.delete({ where: { id } }).catch(() => {});
    for (const id of made.units) await db.unit.delete({ where: { id } }).catch(() => {});
    for (const id of made.terms) await db.term.delete({ where: { id } }).catch(() => {});
    for (const id of made.cohorts) await db.cohort.delete({ where: { id } }).catch(() => {});
    for (const id of made.courses) await db.course.delete({ where: { id } }).catch(() => {});

    // Put the config back exactly as it was — a college left switched ON is the one
    // piece of state here that changes the product for real users.
    //
    // UPSERT on the literal "singleton", not updateMany: this suite deletes the row
    // mid-run before the settings PUT recreates it, and a throw inside that window used
    // to reach here with the table empty — where updateMany matches zero rows, reports
    // success, and the institution's real tap settings stay deleted. The constant key is
    // the same one every config table's save path upserts on.
    if (configExisted) {
      await db.attendanceTapConfig.upsert({
        where: { id: "singleton" },
        update: { settings: priorConfig },
        create: { id: "singleton", settings: priorConfig },
      }).catch(() => {});
    } else {
      await db.attendanceTapConfig.deleteMany({}).catch(() => {});
    }

    // The seeded students have NO password and tokenVersion 0. Restore both.
    for (const id of [QA_ID, QB_ID, QC_ID]) {
      await db.student.update({ where: { id }, data: { passwordHash: null, tokenVersion: 0 } }).catch(() => {});
    }
  } catch (e) {
    console.error("cleanup problem:", e.message);
  }
}

try {
  const existingConfig = await db.attendanceTapConfig.findFirst({});
  configExisted = Boolean(existingConfig);
  priorConfig = existingConfig?.settings ?? {};

  const adminLogin = await login("admin@edtech.co.uk", SEED_PASSWORD);
  const adminToken = adminLogin.data?.token;
  if (!adminToken) throw new Error(`admin sign-in failed (HTTP ${adminLogin.status}) — cannot run this suite`);

  for (const [id] of [[QA_ID], [QB_ID], [QC_ID]]) {
    await db.student.update({ where: { id }, data: { passwordHash: bcrypt.hashSync(S_PASSWORD, 10), tokenVersion: 0 } });
  }
  const qaToken = (await login(QA_EMAIL, S_PASSWORD)).data?.token;
  const qbToken = (await login(QB_EMAIL, S_PASSWORD)).data?.token;
  const qcToken = (await login(QC_EMAIL, S_PASSWORD)).data?.token;
  if (!qaToken || !qbToken || !qcToken) throw new Error("student sign-in failed — cannot run this suite");

  const today = todayLocal();
  const now = nowHHMM();

  // This suite's own timetable. No parking of seeded sessions is needed here, unlike
  // the NFC suite: a QR code names its session, so whatever else the seed timetabled
  // today is never a candidate and cannot make anything ambiguous.
  const unit = await db.unit.create({ data: { code: `QRA${RUN}`.slice(0, 12), name: `QR Suite Unit ${RUN}`, startDate: today, endDate: today } });
  made.units.push(unit.id);
  for (const sid of [QA_ID, QC_ID]) {
    const e = await db.enrolment.create({ data: { studentId: sid, unitId: unit.id } });
    made.enrolments.push(e.id);
  }
  // Started five minutes ago: inside the window, inside the late threshold.
  const live = await db.hndSession.create({ data: { unitId: unit.id, date: today, startTime: shift(now, -5), endTime: shift(now, 115), description: "qr live" } });
  made.sessions.push(live.id);
  // Finished an hour ago: the window refusal.
  const past = await db.hndSession.create({ data: { unitId: unit.id, date: today, startTime: shift(now, -180), endTime: shift(now, -60), description: "qr past" } });
  made.sessions.push(past.id);
  // Starts in an hour: the mint endpoint's "opens at" state.
  const future = await db.hndSession.create({ data: { unitId: unit.id, date: today, startTime: shift(now, 60), endTime: shift(now, 180), description: "qr future" } });
  made.sessions.push(future.id);

  /* ====================================================================== */
  console.log("\n--- the feature ships switched off ---");
  /* ====================================================================== */

  await db.attendanceTapConfig.deleteMany({});

  const offScan = await call("/student/me/qr-check-in", { method: "POST", token: qaToken, body: { sessionId: live.id, code: codeFor(live.id) } });
  check("a scan is refused while QR check-in is off", offScan.status === 403, `HTTP ${offScan.status}`);
  const offRow = await db.tagTap.findFirst({ where: { studentId: QA_ID, method: "qr" }, orderBy: { at: "desc" } });
  check("the refusal is logged with its method, so 'nothing happened' is visible", offRow?.outcome === "disabled" && offRow?.method === "qr", `outcome=${offRow?.outcome}`);

  const offMint = await call(`/hnd/sessions/${live.id}/qr-code`, { token: adminToken });
  check("the screen gets no code while QR check-in is off", offMint.status === 409 && offMint.data?.reason === "qr_disabled", `HTTP ${offMint.status}`);

  /* ====================================================================== */
  console.log("\n--- switching on, and only the QR half ---");
  /* ====================================================================== */

  // NFC tap check-in stays OFF for the whole suite. Every acceptance below is
  // therefore also proof that the two switches are independent.
  const turnedOn = await call("/tags/settings", {
    method: "PUT", token: adminToken,
    body: { qrEnabled: true, qrRotateSeconds: ROTATE, enabled: false, lateAfterMins: 15, earlyGraceMins: 0 },
  });
  check("an administrator can switch QR check-in on with NFC left off",
    turnedOn.status === 200 && turnedOn.data?.qrEnabled === true && turnedOn.data?.enabled === false,
    `HTTP ${turnedOn.status} qrEnabled=${turnedOn.data?.qrEnabled} enabled=${turnedOn.data?.enabled}`);

  // The new key honours both halves of the settings contract, which treat a bad value
  // and a small value differently on purpose. An UNUSABLE value is ignored, not reset —
  // `{ qrRotateSeconds: null }` is reachable from any JSON client and must not undo a
  // number somebody tuned. A usable-but-too-small number is CLAMPED to the ten-second
  // floor instead: somebody typing 5 meant "as fast as possible", not "leave it alone",
  // and a five-second rotation is an outage that presents as "the QR never works".
  await call("/tags/settings", { method: "PUT", token: adminToken, body: { qrRotateSeconds: null } });
  const afterNull = await call("/tags/settings", { token: adminToken });
  check("an unusable rotation is ignored, not reset",
    afterNull.data?.qrRotateSeconds === ROTATE, `qrRotateSeconds=${afterNull.data?.qrRotateSeconds}`);

  await call("/tags/settings", { method: "PUT", token: adminToken, body: { qrRotateSeconds: 5 } });
  const afterFloor = await call("/tags/settings", { token: adminToken });
  check("a rotation below the ten-second floor is raised to the floor",
    afterFloor.data?.qrRotateSeconds === 10, `qrRotateSeconds=${afterFloor.data?.qrRotateSeconds}`);

  // Back to the rotation every derived code below assumes. Asserted, because the whole
  // suite silently derives against the wrong window if this PUT does not take — which
  // is exactly what happened to the first version of this file.
  const restored = await call("/tags/settings", { method: "PUT", token: adminToken, body: { qrRotateSeconds: ROTATE } });
  check("the rotation is restored for the rest of the suite",
    restored.status === 200 && restored.data?.qrRotateSeconds === ROTATE, `qrRotateSeconds=${restored.data?.qrRotateSeconds}`);

  /* ====================================================================== */
  console.log("\n--- the code on the screen ---");
  /* ====================================================================== */

  const mint = await call(`/hnd/sessions/${live.id}/qr-code`, { token: adminToken });
  check("the live session's code is minted for the screen",
    mint.status === 200 && typeof mint.data?.code === "string" && mint.data.code.length === CODE_LENGTH,
    `HTTP ${mint.status} len=${mint.data?.code?.length}`);
  check("the screen is told when the code turns over",
    mint.data?.rotateSeconds === ROTATE && mint.data?.secondsLeft >= 1 && mint.data?.secondsLeft <= ROTATE,
    `secondsLeft=${mint.data?.secondsLeft}`);

  const mintFuture = await call(`/hnd/sessions/${future.id}/qr-code`, { token: adminToken });
  check("no code is minted before the class opens — the screen says when instead",
    mintFuture.status === 200 && mintFuture.data?.code === null && mintFuture.data?.acceptingTaps === false && mintFuture.data?.opensAt === future.startTime,
    `code=${mintFuture.data?.code} opensAt=${mintFuture.data?.opensAt}`);

  const mintUnknown = await call(`/hnd/sessions/no-such-session/qr-code`, { token: adminToken });
  check("a session that does not exist has no code", mintUnknown.status === 404, `HTTP ${mintUnknown.status}`);

  const studentMints = await call(`/hnd/sessions/${live.id}/qr-code`, { token: qaToken });
  check("a student token cannot reach the lecturer's code", studentMints.status === 403, `HTTP ${studentMints.status}`);
  const studentLive = await call(`/hnd/sessions/${live.id}/live`, { token: qaToken });
  check("a student token cannot reach the lecturer's live register", studentLive.status === 403, `HTTP ${studentLive.status}`);

  /* ====================================================================== */
  console.log("\n--- what verification refuses ---");
  /* ====================================================================== */

  const garbage = await call("/student/me/qr-check-in", { method: "POST", token: qaToken, body: { sessionId: live.id, code: "x".repeat(CODE_LENGTH) } });
  check("a code we never issued is refused as never ours",
    garbage.status === 404 && garbage.data?.reason === "qr_bad_code", `HTTP ${garbage.status} ${garbage.data?.reason || ""}`);
  const garbageRow = await db.tagTap.findFirst({ where: { studentId: QA_ID, outcome: "qr_bad_code" }, orderBy: { at: "desc" } });
  check("the refusal still names the register it was aimed at",
    garbageRow?.sessionId === live.id && garbageRow?.method === "qr", `sessionId=${garbageRow?.sessionId}`);

  // A real code for one session, replayed against another. The signature binds the
  // code to its session, so this must read exactly like a forgery — not like a window
  // problem, which would invite "scan again" against the wrong register.
  const crossSession = await call("/student/me/qr-check-in", { method: "POST", token: qaToken, body: { sessionId: live.id, code: codeFor(past.id) } });
  check("one lecture's code does not open another lecture's register",
    crossSession.status === 404 && crossSession.data?.reason === "qr_bad_code", `HTTP ${crossSession.status}`);

  const expired = await call("/student/me/qr-check-in", { method: "POST", token: qaToken, body: { sessionId: live.id, code: codeFor(live.id, -2) } });
  check("a code from two rotations ago is refused as expired — a different sentence with a different next step",
    expired.status === 409 && expired.data?.reason === "qr_expired", `HTTP ${expired.status} ${expired.data?.reason || ""}`);

  // No forward tolerance: a code that verifies before it is displayed is a replay
  // window with extra steps. It must not even earn the "expired" diagnosis.
  await avoidBoundary();
  const forward = await call("/student/me/qr-check-in", { method: "POST", token: qaToken, body: { sessionId: live.id, code: codeFor(live.id, +1) } });
  check("a code from a window that has not happened yet was never ours",
    forward.status === 404 && forward.data?.reason === "qr_bad_code", `HTTP ${forward.status} ${forward.data?.reason || ""}`);

  // Honest code, honest session, wrong time of day — refused by the session's own
  // window, exactly as a tap would be. QC spends this so QA's budget survives.
  const ended = await call("/student/me/qr-check-in", { method: "POST", token: qcToken, body: { sessionId: past.id, code: codeFor(past.id) } });
  check("a scan after the lecture has ended is refused",
    ended.status === 409 && ended.data?.reason === "no_session_now", `HTTP ${ended.status} ${ended.data?.reason || ""}`);

  // A valid signature over a session id that names nothing. Deleted mid-lecture is
  // the real-world route here; the answer must not be a 500.
  const ghostId = "clghostsession0000000000x";
  const ghost = await call("/student/me/qr-check-in", { method: "POST", token: qcToken, body: { sessionId: ghostId, code: codeFor(ghostId) } });
  check("a code for a session that no longer exists is refused cleanly", ghost.status === 404, `HTTP ${ghost.status}`);

  // Enrolment is still checked: the code proves which screen was scanned, never that
  // the scanner belongs in the room.
  const otherUnit = await db.unit.create({ data: { code: `QRB${RUN}`.slice(0, 12), name: `QR Other Unit ${RUN}`, startDate: today, endDate: today } });
  made.units.push(otherUnit.id);
  const otherLive = await db.hndSession.create({ data: { unitId: otherUnit.id, date: today, startTime: shift(now, -5), endTime: shift(now, 115), description: "qr other" } });
  made.sessions.push(otherLive.id);
  const notEnrolled = await call("/student/me/qr-check-in", { method: "POST", token: qcToken, body: { sessionId: otherLive.id, code: codeFor(otherLive.id) } });
  check("a student not enrolled on the unit is refused, current code or not",
    notEnrolled.status === 403, `HTTP ${notEnrolled.status} ${notEnrolled.data?.reason || notEnrolled.data?.error || ""}`);
  const notEnrolledRow = await db.tagTap.findFirst({ where: { studentId: QC_ID, outcome: "not_enrolled" }, orderBy: { at: "desc" } });
  check("that refusal is in the log with the register it named",
    notEnrolledRow?.sessionId === otherLive.id && notEnrolledRow?.method === "qr", `sessionId=${notEnrolledRow?.sessionId}`);

  /* ====================================================================== */
  console.log("\n--- marking, with the minute ---");
  /* ====================================================================== */

  const marked = await call("/student/me/qr-check-in", { method: "POST", token: qaToken, body: { sessionId: live.id, code: mint.data.code } });
  check("a scan during the lecture is marked Present",
    marked.status === 201 && marked.data?.status === "P", `HTTP ${marked.status} ${marked.data?.status || marked.data?.error || ""}`);

  const markRow = await db.attendanceMark.findFirst({ where: { sessionId: live.id, studentId: QA_ID } });
  if (markRow) made.marks.push(markRow.id);
  check("checkedInAt records the minute, not a timestamp",
    !!markRow && /^\d{2}:\d{2}$/.test(markRow.checkedInAt || ""), `checkedInAt=${markRow?.checkedInAt}`);
  check("the mark is stamped as a QR self check-in, not as a lecturer's",
    !!markRow && markRow.takenBy === "Self check-in (QR)", `takenBy=${markRow?.takenBy}`);
  const markedRow = await db.tagTap.findFirst({ where: { studentId: QA_ID, outcome: "marked" }, orderBy: { at: "desc" } });
  check("the accepted scan's log row records the method as qr",
    markedRow?.method === "qr" && markedRow?.sessionId === live.id, `method=${markedRow?.method}`);

  // The selfMarked hazard from the design note: the lecturer's live view must read a
  // QR check-in as self-marked, which only holds if hnd.js uses the predicate rather
  // than an equality against the NFC stamp.
  const liveView = await call(`/hnd/sessions/${live.id}/live`, { token: adminToken });
  const qaRow = liveView.data?.rows?.find((r) => r.student?.id === QA_ID);
  check("the lecturer's live view shows the scan as self-marked",
    liveView.status === 200 && qaRow?.selfMarked === true && qaRow?.status === "P", `selfMarked=${qaRow?.selfMarked}`);
  check("the live view carries the QR switch for the screen",
    liveView.data?.qrEnabled === true, `qrEnabled=${liveView.data?.qrEnabled}`);

  // A second scan with the PREVIOUS window's code: the trailing tolerance verifies it
  // (or this would be qr_expired, not alreadyMarked) — and no second mark is written,
  // no arrival time moves.
  const firstCheckedInAt = markRow?.checkedInAt;
  await avoidBoundary();
  const again = await call("/student/me/qr-check-in", { method: "POST", token: qaToken, body: { sessionId: live.id, code: codeFor(live.id, -1) } });
  const markCount = await db.attendanceMark.count({ where: { sessionId: live.id, studentId: QA_ID } });
  const afterAgain = await db.attendanceMark.findFirst({ where: { sessionId: live.id, studentId: QA_ID } });
  check("the previous window's code still verifies, and a second scan does not double-mark",
    again.status === 200 && again.data?.alreadyMarked === true && markCount === 1,
    `HTTP ${again.status} ${again.data?.reason || again.data?.error || ""}, ${markCount} mark(s)`);
  check("a second scan does not move the recorded arrival time",
    afterAgain?.checkedInAt === firstCheckedInAt, `${firstCheckedInAt} -> ${afterAgain?.checkedInAt}`);

  // Late is derived from the session's own start, exactly as a tap's would be.
  const lateSession = await db.hndSession.create({ data: { unitId: unit.id, date: today, startTime: shift(now, -45), endTime: shift(now, 75), description: "qr late" } });
  made.sessions.push(lateSession.id);
  const lateScan = await call("/student/me/qr-check-in", { method: "POST", token: qaToken, body: { sessionId: lateSession.id, code: codeFor(lateSession.id) } });
  const lateMark = await db.attendanceMark.findFirst({ where: { sessionId: lateSession.id, studentId: QA_ID } });
  if (lateMark) made.marks.push(lateMark.id);
  check("a scan past the late threshold records L, not P",
    lateScan.status === 201 && lateScan.data?.status === "L",
    `HTTP ${lateScan.status} ${lateScan.data?.status || lateScan.data?.reason || lateScan.data?.error || ""}`);

  /* ====================================================================== */
  console.log("\n--- what a scan must never overwrite ---");
  /* ====================================================================== */

  // A lecturer already marked QA absent on this one. The human in the room wins.
  // startTime differs from `live`'s: HndSession is unique on (unitId, date, startTime).
  const guarded = await db.hndSession.create({ data: { unitId: unit.id, date: today, startTime: shift(now, -10), endTime: shift(now, 115), description: "qr guarded" } });
  made.sessions.push(guarded.id);
  const planted = await db.attendanceMark.create({ data: { sessionId: guarded.id, studentId: QA_ID, status: "A", remark: "", takenBy: "A. Lecturer" } });
  made.marks.push(planted.id);

  const overwrite = await call("/student/me/qr-check-in", { method: "POST", token: qaToken, body: { sessionId: guarded.id, code: codeFor(guarded.id) } });
  const survived = await db.attendanceMark.findUnique({ where: { id: planted.id } });
  check("a scan cannot overwrite a mark a lecturer already set",
    overwrite.status === 200 && overwrite.data?.alreadyMarked === true && survived?.status === "A" && survived?.takenBy === "A. Lecturer",
    `status=${survived?.status} takenBy=${survived?.takenBy}`);
  check("the lecturer's mark keeps its empty arrival time — the student never arrived",
    survived?.checkedInAt == null, `checkedInAt=${survived?.checkedInAt}`);

  /* ====================================================================== */
  console.log("\n--- the term lock is not a suggestion ---");
  /* ====================================================================== */

  // A Term needs a Cohort, which needs a Course — the seed provides none of the three.
  const termCourse = await db.course.create({ data: { name: `QR Suite Course ${RUN}` } }).catch(() => null);
  if (termCourse) made.courses.push(termCourse.id);
  const termCohort = termCourse ? await db.cohort.create({ data: { courseId: termCourse.id, name: `QR Intake ${RUN}` } }).catch(() => null) : null;
  if (termCohort) made.cohorts.push(termCohort.id);
  const closedTerm = termCohort
    ? await db.term.create({ data: { cohortId: termCohort.id, year: 1, index: 1, name: `QR Closed Term ${RUN}`, start: "2020-01-06", end: "2020-06-30" } }).catch(() => null)
    : null;

  if (!closedTerm) {
    console.log("SKIP  could not create a Term fixture — the term lock is NOT exercised in this run");
  } else {
    const termUnit = await db.unit.create({ data: { code: `QRT${RUN}`.slice(0, 12), name: `QR Term Locked ${RUN}`, termId: closedTerm.id } });
    made.units.push(termUnit.id);
    const qbEnrol = await db.enrolment.create({ data: { studentId: QB_ID, unitId: termUnit.id } });
    made.enrolments.push(qbEnrol.id);
    // Timetabled TODAY, running NOW — only the term stands in the way, so the refusal
    // below is the term lock and nothing else.
    const lockedSession = await db.hndSession.create({ data: { unitId: termUnit.id, date: today, startTime: shift(now, -5), endTime: shift(now, 115), description: "qr locked" } });
    made.sessions.push(lockedSession.id);

    const lockedScan = await call("/student/me/qr-check-in", { method: "POST", token: qbToken, body: { sessionId: lockedSession.id, code: codeFor(lockedSession.id) } });
    check("a scan against a locked term answers 423, matching the register save it enforces",
      lockedScan.status === 423 && lockedScan.data?.reason === "term_locked", `HTTP ${lockedScan.status} ${lockedScan.data?.reason || ""}`);
    const lockedMark = await db.attendanceMark.findFirst({ where: { sessionId: lockedSession.id, studentId: QB_ID } });
    check("and writes nothing", !lockedMark, lockedMark ? `mark ${lockedMark.id} written` : "");

    // The screen must agree with the scan. Minting a live code for a locked-term session
    // puts a QR on the projector that every phone in the room is refused against — the
    // exact "open now but every tap refused" failure the today list's acceptingTaps
    // comment records, arriving back through a fresh copy of the window test.
    const lockedMint = await call(`/hnd/sessions/${lockedSession.id}/qr-code`, { token: adminToken });
    check("the screen is told the register is closed rather than being handed a code every scan refuses",
      lockedMint.status === 200 && !lockedMint.data?.code && lockedMint.data?.acceptingTaps === false && lockedMint.data?.phase === "closed",
      `HTTP ${lockedMint.status} code=${lockedMint.data?.code ? "minted" : "none"} phase=${lockedMint.data?.phase || "—"}`);
    const lockedLive = await call(`/hnd/sessions/${lockedSession.id}/live`, { token: adminToken });
    check("and the live view's badge agrees a locked term is not accepting",
      lockedLive.status === 200 && lockedLive.data?.acceptingTaps === false,
      `HTTP ${lockedLive.status} acceptingTaps=${lockedLive.data?.acceptingTaps}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
} catch (e) {
  console.error("suite error:", e);
  process.exitCode = 1;
} finally {
  await cleanup();
  await db.$disconnect();
}
