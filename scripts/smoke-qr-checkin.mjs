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
// secrets.js) under the same JWT_SECRET the runner hands the API — that is what lets this
// suite hold a code from two windows ago or one window in the future without waiting for
// real time to pass. The signing key derives from the SESSION secret, so this suite and
// the API must be given the same one or nothing it mints will verify.
//
//   node scripts/smoke-qr-checkin.mjs
//   (needs API_URL + DATABASE_URL + JWT_SECRET; the runner supplies all three)
import { createRequire } from "node:module";
import { fixtureDepartmentFor, stamp } from "./lib/fixture-department.mjs";
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
// secret this suite cannot derive a single code that the API would agree with — there is
// nothing to exercise, and pretending otherwise would count as coverage. The runner always
// sets it; only a bare standalone run lands here.
if (!process.env.JWT_SECRET) {
  console.log("SKIP — JWT_SECRET is not set, so no code can be derived or verified in this run");
  process.exit(2);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const bcrypt = require(join(server, "node_modules", "bcryptjs"));
const { deriveCode, windowIndexFor, CODE_LENGTH, GRACE_SECONDS } = require(join(server, "src", "attendanceQr.js"));
const { qrSigningKey } = require(join(server, "src", "secrets.js"));
// The platform default, READ rather than repeated. This suite derives codes itself, so a
// rotation period that disagrees with the server's produces a different window index and
// every happy-path scan below fails for a reason that looks nothing like the cause. It
// was a literal 30 and the default moved to 20 underneath it, which is exactly the drift
// this import removes.
const { DEFAULTS: TAP_DEFAULTS } = require(join(server, "src", "attendanceTapSettings.js"));

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
const ROTATE = TAP_DEFAULTS.qrRotateSeconds;
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

// The opposite of avoidBoundary: wait until we are JUST PAST a rotation, because that is
// the only moment the grace can be observed at all.
//
// The previous window's code used to verify for the whole of the current one, so this
// distinction did not exist and any instant would do. It verifies for GRACE_SECONDS now,
// which is the point of the change — a code's life went from twice the rotation period to
// the rotation plus a few seconds — and an assertion about it has to stand at a known
// distance from the boundary or it tests whatever the clock happened to be doing.
//
// Costs at most one rotation period, once.
const justAfterBoundary = async () => {
  const into = Math.floor(Date.now() / 1000) % ROTATE;
  if (into !== 0) await new Promise((r) => setTimeout(r, (ROTATE - into) * 1000 + 300));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
// The fourth exists to be rate limited on purpose. Spending a budget is destructive to
// every later assertion by that student, so it is done by somebody with nothing else to do.
const QD_ID = "st-100135";
const QD_EMAIL = "100135@edtech.co.uk";
// Two more with budgets of their own, for the blocks added 5 Sep 2026 (the department
// boundary and the edges of the window). Spending QA's or QC's budget on them pushed the
// device-trail scan near the end of the suite into a 429. 100110 is the local bench's
// student and no other suite's, which is what makes it free here.
const QE_ID = "st-100133";
const QE_EMAIL = "100133@edtech.co.uk";
const QF_ID = "st-100110";
const QF_EMAIL = "100110@edtech.co.uk";
// Comfortably past TAP_MAX (10 a minute, student.js) without depending on the number.
const FLOOD = 14;
const S_PASSWORD = "qr-checkin-suite-2026";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function call(path, { method = "GET", body, token, headers: extra } = {}) {
  const headers = { "Content-Type": "application/json", ...(extra || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  return { status: res.status, data };
}
const login = (email, password) => call("/auth/login", { method: "POST", body: { email, password } });

const nowHHMM = () => new Date().toLocaleTimeString("en-GB", { timeZone: process.env.APP_TIMEZONE || "Europe/London", hour: "2-digit", minute: "2-digit" });
const todayLocal = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.APP_TIMEZONE || "Europe/London" });
// One day on from the college's today. The date-parameter assertions below do not depend
// on anything being scheduled tomorrow — only on the ANSWER being about that day rather
// than this one — so an empty list is a valid result and the checks say so.
const tomorrowLocal = () => new Date(Date.parse(`${todayLocal()}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const shift = (hhmm, mins) => {
  const [h, m] = hhmm.split(":").map(Number);
  const t = Math.max(0, Math.min(23 * 60 + 59, h * 60 + m + mins));
  return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
};

// Everything this run creates, so the finally block puts the database back exactly as
// the seed left it — the suites share one seeded database.
const made = { sessions: [], events: [], units: [], enrolments: [], marks: [], terms: [], cohorts: [], courses: [], staff: [], departments: [] };
let configExisted = false, priorConfig = null;

async function cleanup() {
  try {
    // Every QR tap row these three students produced, including the refusals this
    // suite asserted only by their HTTP answers. Bulk on (student, method) rather
    // than tracked ids because EVERY outcome logs a row and most are never read back.
    await db.tagTap.deleteMany({ where: { studentId: { in: [QA_ID, QB_ID, QC_ID, QD_ID, QE_ID, QF_ID] }, method: "qr" } }).catch(() => {});
    for (const id of made.marks) await db.attendanceMark.delete({ where: { id } }).catch(() => {});
    for (const id of made.sessions) await db.hndSession.delete({ where: { id } }).catch(() => {});
    // After the sessions: HndSession.timetableEventId is SetNull, so deleting an event
    // first would leave orphaned registers behind rather than failing loudly.
    // TimetableEventStaff cascades from the event, so the join rows go with it.
    for (const id of made.events) await db.timetableEvent.delete({ where: { id } }).catch(() => {});
    for (const id of made.enrolments) await db.enrolment.delete({ where: { id } }).catch(() => {});
    for (const id of made.units) await db.unit.delete({ where: { id } }).catch(() => {});
    for (const id of made.terms) await db.term.delete({ where: { id } }).catch(() => {});
    for (const id of made.cohorts) await db.cohort.delete({ where: { id } }).catch(() => {});
    for (const id of made.courses) await db.course.delete({ where: { id } }).catch(() => {});
    for (const id of made.staff) await db.staff.delete({ where: { id } }).catch(() => {});
    // After the units and the staff: deleting a department nulls the units pointing at it
    // and cascades the memberships, and both are already gone by here.
    for (const id of made.departments) await db.academicDepartment.delete({ where: { id } }).catch(() => {});

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
    for (const id of [QA_ID, QB_ID, QC_ID, QD_ID, QE_ID, QF_ID]) {
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

  // The department the signing-in admin is narrowed to, if any. Null on the ordinary pass

  // (nothing stamped, fixtures exactly as before); under SMOKE_SCOPED_DEPARTMENT=1 it is

  // the one department everything seeded belongs to, and every unit, course and cohort

  // this suite builds carries it — so the same assertions hold on the guard's other side.

  const DEPT = await fixtureDepartmentFor(db, "admin@edtech.co.uk");
  const adminToken = adminLogin.data?.token;
  if (!adminToken) throw new Error(`admin sign-in failed (HTTP ${adminLogin.status}) — cannot run this suite`);

  for (const [id] of [[QA_ID], [QB_ID], [QC_ID], [QD_ID], [QE_ID], [QF_ID]]) {
    await db.student.update({ where: { id }, data: { passwordHash: bcrypt.hashSync(S_PASSWORD, 10), tokenVersion: 0 } });
  }
  const qaToken = (await login(QA_EMAIL, S_PASSWORD)).data?.token;
  const qbToken = (await login(QB_EMAIL, S_PASSWORD)).data?.token;
  const qcToken = (await login(QC_EMAIL, S_PASSWORD)).data?.token;
  const qeToken = (await login(QE_EMAIL, S_PASSWORD)).data?.token;
  const qfToken = (await login(QF_EMAIL, S_PASSWORD)).data?.token;
  if (!qaToken || !qbToken || !qcToken || !qeToken || !qfToken) throw new Error("student sign-in failed — cannot run this suite");

  const today = todayLocal();
  const now = nowHHMM();

  // This suite's own timetable. No parking of seeded sessions is needed here, unlike
  // the NFC suite: a QR code names its session, so whatever else the seed timetabled
  // today is never a candidate and cannot make anything ambiguous.
  const unit = await db.unit.create({ data: { ...stamp(DEPT), code: `QRA${RUN}`.slice(0, 12), name: `QR Suite Unit ${RUN}`, startDate: today, endDate: today } });
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
  console.log("\n--- what a college gets before it has touched the settings ---");
  /* ====================================================================== */

  // NO settings row at all, which is every college that has never opened the screen. The
  // resolver then answers the shipped defaults, and since 4 Sep 2026 those are QR ON and
  // stickers OFF. Asserted over HTTP rather than against DEFAULTS, because the unit test
  // already pins the constant and what matters here is what a real request actually gets.
  await db.attendanceTapConfig.deleteMany({});

  const bareCtx = await call("/student/me/tap-context", { token: qcToken });
  check("a college that has never opened the settings gets QR check-in on",
    bareCtx.status === 200 && bareCtx.data?.qrEnabled === true, `HTTP ${bareCtx.status} qrEnabled=${bareCtx.data?.qrEnabled}`);
  check("and does NOT get sticker check-in, which needs hardware nobody has placed",
    bareCtx.data?.enabled === false, `enabled=${bareCtx.data?.enabled}`);
  const bareMint = await call(`/hnd/sessions/${live.id}/qr-code`, { token: adminToken });
  check("so the lecturer's screen has a code without anybody configuring anything",
    bareMint.status === 200 && typeof bareMint.data?.code === "string", `HTTP ${bareMint.status}`);

  /* ====================================================================== */
  console.log("\n--- and what it gets once it switches the code off ---");
  /* ====================================================================== */

  // Explicitly off, which is a college that has opened the screen and said no. Deleting
  // the row no longer expresses this: with the default on, "no row" means ON.
  await call("/tags/settings", { method: "PUT", token: adminToken, body: { qrEnabled: false } });

  const offScan = await call("/student/me/qr-check-in", { method: "POST", token: qaToken, body: { sessionId: live.id, code: codeFor(live.id) } });
  check("a scan is refused while QR check-in is off", offScan.status === 403, `HTTP ${offScan.status}`);
  // Every refusal a student can reach carries a machine-readable reason, because the
  // phone chooses its OWN wording from it. Without one the card falls back to printing
  // whatever the server said, and server messages are written for whoever operates the
  // deployment — one of them is a configuration key's setup instructions.
  check("and names a reason, so the phone never has to quote the server at a student",
    offScan.data?.reason === "qr_off", `reason=${offScan.data?.reason || "none"}`);
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

  // The student's OWN screen on a QR-only college, which is the configuration this whole
  // suite runs in and the one nothing here was reading.
  //
  // tap-context returned early on the STICKER switch and left the running-now list and
  // the next-class field hardcoded empty. Everything downstream believes those: the
  // check-in screen concluded no class was on and said "that's you done for today" to a
  // student sitting in the lecture, with the code on the wall behind them. The handler
  // already knew this hazard for the qrEnabled FLAG and fixed only the flag.
  const ctx = await call("/student/me/tap-context", { token: qaToken });
  check("a QR-only college still tells the student which class is running",
    ctx.status === 200 && (ctx.data?.now || []).some((x) => x.id === live.id),
    `HTTP ${ctx.status} now=[${(ctx.data?.now || []).map((x) => x.id).join(", ")}]`);
  check("and still names the class they have next",
    !!ctx.data?.next, `next=${ctx.data?.next?.id || "null"}`);
  check("while still reporting the sticker switch as off",
    ctx.data?.enabled === false && ctx.data?.qrEnabled === true,
    `enabled=${ctx.data?.enabled} qrEnabled=${ctx.data?.qrEnabled}`);

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
  // THE NUMBER THE WHOLE FEATURE'S HONESTY RESTS ON, asserted end to end rather than only
  // in the settings unit test — it travels through the merge, the config cache and the
  // serialiser before it reaches the projector, and a college reading "20 seconds" on the
  // settings screen is only being told the truth if this is the value the mint actually
  // uses. Twenty since 11 Sep 2026; it was thirty.
  check("...and it is the twenty seconds this college is configured for",
    mint.data?.rotateSeconds === 20, `rotateSeconds=${mint.data?.rotateSeconds}`);

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
  check("and names a reason too", ghost.data?.reason === "no_session", `reason=${ghost.data?.reason || "none"}`);

  // Enrolment is still checked: the code proves which screen was scanned, never that
  // the scanner belongs in the room.
  const otherUnit = await db.unit.create({ data: { ...stamp(DEPT), code: `QRB${RUN}`.slice(0, 12), name: `QR Other Unit ${RUN}`, startDate: today, endDate: today } });
  made.units.push(otherUnit.id);
  const otherLive = await db.hndSession.create({ data: { unitId: otherUnit.id, date: today, startTime: shift(now, -5), endTime: shift(now, 115), description: "qr other" } });
  made.sessions.push(otherLive.id);
  const notEnrolled = await call("/student/me/qr-check-in", { method: "POST", token: qcToken, body: { sessionId: otherLive.id, code: codeFor(otherLive.id) } });
  check("a student not enrolled on the unit is refused, current code or not",
    notEnrolled.status === 403, `HTTP ${notEnrolled.status} ${notEnrolled.data?.reason || notEnrolled.data?.error || ""}`);
  check("a student who is not on the class names a reason too",
    notEnrolled.data?.reason === "not_enrolled", `reason=${notEnrolled.data?.reason || "none"}`);
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

  // THE ROTATION GRACE, END TO END — and the shape of this block changed on 11 Sep 2026
  // along with the rule it tests.
  //
  // It used to scan with the previous window's code at any old moment, because the
  // previous window verified for the WHOLE of the current one. That made a code live for
  // up to twice the rotation period, which quietly gave away half of what the rotation
  // setting promises: the number a college sets is how long a photographed screen keeps
  // working, and it was really that number doubled. The previous code is now accepted for
  // GRACE_SECONDS after it leaves the screen and no longer, so both halves are asserted at
  // a KNOWN distance from the boundary rather than wherever the clock happened to be.
  const firstCheckedInAt = markRow?.checkedInAt;

  await justAfterBoundary();
  const graceCode = codeFor(live.id, -1);
  const again = await call("/student/me/qr-check-in", { method: "POST", token: qaToken, body: { sessionId: live.id, code: graceCode } });
  const markCount = await db.attendanceMark.count({ where: { sessionId: live.id, studentId: QA_ID } });
  const afterAgain = await db.attendanceMark.findFirst({ where: { sessionId: live.id, studentId: QA_ID } });
  check("A CODE THAT JUST ROTATED OFF STILL VERIFIES, so a slow phone is not punished",
    again.status === 200 && again.data?.alreadyMarked === true && markCount === 1,
    `HTTP ${again.status} ${again.data?.reason || again.data?.error || ""}, ${markCount} mark(s)`);
  check("a second scan does not move the recorded arrival time",
    afterAgain?.checkedInAt === firstCheckedInAt, `${firstCheckedInAt} -> ${afterAgain?.checkedInAt}`);

  // ...AND STOPS VERIFYING ONCE THE GRACE HAS PASSED. The same code, a few seconds later.
  // This is the assertion that fails if the tolerance is ever widened back to a whole
  // window, which is the change that would silently double how long a photographed screen
  // keeps working.
  await sleep((GRACE_SECONDS + 1) * 1000);
  const tooLate = await call("/student/me/qr-check-in", { method: "POST", token: qaToken, body: { sessionId: live.id, code: graceCode } });
  check("...AND STOPS VERIFYING ONCE THE GRACE HAS PASSED",
    tooLate.status === 409 && tooLate.data?.reason === "qr_expired",
    `HTTP ${tooLate.status} ${tooLate.data?.reason}`);
  // "Scan the new one" and "that was never one of ours" are different sentences with
  // different next steps, and this is the commonest refusal there is — a student a few
  // seconds late. It read as a forgery for a moment while this change was being made,
  // because the diagnostic loop still started where the acceptance loop used to stop.
  check("...and is reported as expired, not as a forgery",
    /expired/i.test(tooLate.data?.error || tooLate.data?.reason || ""), tooLate.data?.error);

  /* ====================================================================== */
  console.log("\n--- one code, a whole class ---");
  /* ====================================================================== */

  // The projector shows ONE code and a room full of phones reads it. Nothing about a
  // code names a student — it is derived from the session and the clock alone — so this
  // is the property the whole feature rests on, and it had no assertion: every accepted
  // scan above this point is the same student twice.
  await avoidBoundary();
  const sharedCode = codeFor(live.id);
  const qcShared = await call("/student/me/qr-check-in", { method: "POST", token: qcToken, body: { sessionId: live.id, code: sharedCode } });
  check("a second student scanning the SAME code is marked in their own right",
    qcShared.status === 201 && qcShared.data?.status === "P" && !qcShared.data?.alreadyMarked,
    `HTTP ${qcShared.status} ${qcShared.data?.status || qcShared.data?.error || ""}`);

  const qcMark = await db.attendanceMark.findFirst({ where: { sessionId: live.id, studentId: QC_ID } });
  if (qcMark) made.marks.push(qcMark.id);
  check("the second student's mark is their own row, not a share of the first's",
    !!qcMark && qcMark.studentId === QC_ID && qcMark.takenBy === "Self check-in (QR)", `studentId=${qcMark?.studentId}`);

  const bothMarks = await db.attendanceMark.count({ where: { sessionId: live.id } });
  check("the register holds one mark per student who scanned, not one per code",
    bothMarks === 2, `${bothMarks} mark(s) on the register`);

  const qaStill = await db.attendanceMark.findFirst({ where: { sessionId: live.id, studentId: QA_ID } });
  check("and the first student's arrival time is untouched by the second's scan",
    qaStill?.checkedInAt === firstCheckedInAt, `${firstCheckedInAt} -> ${qaStill?.checkedInAt}`);

  /* ====================================================================== */
  console.log("\n--- the attempt budget is one student's, not the room's ---");
  /* ====================================================================== */

  // A lecture theatre is one network and frequently one address. Keyed on anything but
  // the student, the fifteenth phone to scan would be refused because of the fourteen
  // before it, and the feature would fail precisely when a whole class uses it at once.
  // The limiter IS keyed on the student and there is no address-based limiter anywhere
  // in the API — but nothing asserted either, so a later "let's add an IP limit" would
  // land silently.
  const qdToken = (await login(QD_EMAIL, S_PASSWORD)).data?.token;
  if (!qdToken) throw new Error("fourth student sign-in failed — cannot run this suite");

  // A garbage code is refused on the signature before any lookup, so this spends the
  // budget without writing a mark or leaning on any fixture.
  const junk = "z".repeat(CODE_LENGTH);
  let qdFirst = null, qdLimited = 0;
  for (let i = 0; i < FLOOD; i++) {
    const r = await call("/student/me/qr-check-in", { method: "POST", token: qdToken, body: { sessionId: live.id, code: junk } });
    if (i === 0) qdFirst = r.status;
    if (r.status === 429) qdLimited++;
  }
  check("a student hammering the endpoint is eventually refused for it",
    qdFirst !== 429 && qdLimited > 0, `first=${qdFirst}, ${qdLimited} of ${FLOOD} refused as 429`);

  const flooded = await call("/student/me/qr-check-in", { method: "POST", token: qdToken, body: { sessionId: live.id, code: junk } });
  check("a rate-limited refusal names a reason too",
    flooded.status === 429 && flooded.data?.reason === "too_many", `HTTP ${flooded.status} reason=${flooded.data?.reason || "none"}`);

  const neighbour = await call("/student/me/qr-check-in", { method: "POST", token: qcToken, body: { sessionId: live.id, code: codeFor(live.id) } });
  check("and the student sitting next to them is entirely unaffected by it",
    neighbour.status === 200 && neighbour.data?.alreadyMarked === true,
    `HTTP ${neighbour.status} ${neighbour.data?.reason || neighbour.data?.error || ""}`);

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
  const termCourse = await db.course.create({ data: { ...stamp(DEPT), name: `QR Suite Course ${RUN}` } }).catch(() => null);
  if (termCourse) made.courses.push(termCourse.id);
  const termCohort = termCourse ? await db.cohort.create({ data: { ...stamp(DEPT), courseId: termCourse.id, name: `QR Intake ${RUN}` } }).catch(() => null) : null;
  if (termCohort) made.cohorts.push(termCohort.id);
  const closedTerm = termCohort
    ? await db.term.create({ data: { cohortId: termCohort.id, year: 1, index: 1, name: `QR Closed Term ${RUN}`, start: "2020-01-06", end: "2020-06-30" } }).catch(() => null)
    : null;

  if (!closedTerm) {
    console.log("SKIP  could not create a Term fixture — the term lock is NOT exercised in this run");
  } else {
    const termUnit = await db.unit.create({ data: { ...stamp(DEPT), code: `QRT${RUN}`.slice(0, 12), name: `QR Term Locked ${RUN}`, termId: closedTerm.id } });
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


  /* ====================================================================== */
  console.log("\n--- the lecturer's door ---");
  /* ====================================================================== */

  // An ordinary teaching account holds no admin page, and until now could not reach any
  // of this: the code, the live register and the close button all sat behind DEF-01's
  // router-wide gate. Being recorded as the TUTOR of a unit is the authority a college
  // already keeps, so it opens exactly four routes for exactly that person's classes —
  // and the assertions below are as much about what stays shut as what opens.
  //
  // Two seeded STAFF accounts: s1 is made the tutor of this suite's unit; s2 teaches
  // nothing and stands in for every other member of staff.
  const TUTOR_ID = "s1", TUTOR_NAME = "James Whitfield", OTHER_ID = "s2";
  await db.unit.update({ where: { id: unit.id }, data: { tutorStaffId: TUTOR_ID } });
  const tutorToken = (await login("j.whitfield@edtech.co.uk", SEED_PASSWORD)).data?.token;
  const otherToken = (await login("a.rahman@edtech.co.uk", SEED_PASSWORD)).data?.token;
  check("the two seeded staff accounts can sign in", Boolean(tutorToken && otherToken), "");
  // A second live class on the tutor's unit, with nobody marked on it yet, so closing it
  // below has something to write and the earlier fixtures keep their marks.
  const tutorSess = await db.hndSession.create({ data: { unitId: unit.id, date: today, startTime: shift(now, -13), endTime: shift(now, 107), description: "qr tutor" } });
  made.sessions.push(tutorSess.id);

  const nonTutorToday = await call("/hnd/my-sessions/today", { token: otherToken });
  check("a member of staff teaching nothing is told so, and sees none of these classes",
    nonTutorToday.status === 200 && nonTutorToday.data?.teaches === false
      && !(nonTutorToday.data?.sessions || []).some((x) => x.id === tutorSess.id || x.id === live.id),
    `HTTP ${nonTutorToday.status} teaches=${nonTutorToday.data?.teaches} n=${(nonTutorToday.data?.sessions || []).length}`);

  const tutorToday = await call("/hnd/my-sessions/today", { token: tutorToken });
  check("the tutor of a unit sees today's classes on it without holding any admin page",
    tutorToday.status === 200 && tutorToday.data?.teaches === true
      && (tutorToday.data?.sessions || []).some((x) => x.id === tutorSess.id)
      && (tutorToday.data?.sessions || []).some((x) => x.id === live.id),
    `HTTP ${tutorToday.status} teaches=${tutorToday.data?.teaches} n=${(tutorToday.data?.sessions || []).length}`);
  check("and is not offered the whole college", tutorToday.data?.canSeeAll === false, `canSeeAll=${tutorToday.data?.canSeeAll}`);
  const tutorAll = await call("/hnd/my-sessions/today?scope=all", { token: tutorToken });
  check("the tutor cannot widen the list to the whole college", tutorAll.status === 403, `HTTP ${tutorAll.status}`);

  // --- asking about a DAY THAT IS NOT TODAY ---
  //
  // This screen answers "what is happening" for one date and could only ever be asked
  // about the current one. On the Wednesday before a term starting on the Tuesday, an
  // administrator checking the registers exist saw an empty page with no way to tell a
  // correctly-quiet Wednesday from a term that had failed to save.
  //
  // It must widen NOTHING: the same "who teaches this" filter runs whatever the date, so
  // a lecturer may look at their own other days and nobody else's, and ?scope=all is
  // still refused. Both are asserted here beside the feature, because a date parameter
  // that quietly bypassed the scope gate would look identical on the screen.
  const TOM = tomorrowLocal();
  // A CLASS TOMORROW, AT THE SAME CLOCK TIME AS ONE RUNNING NOW. Without it the
  // accepting-taps assertion below runs over an empty array and .every() is vacuously
  // true — it would pass just as happily against a server that had never heard of the
  // date parameter. This session is deliberately timed to be "in progress" by the wall
  // clock, so the ONLY thing stopping it reading as live is the day being wrong.
  const tomSess = await db.hndSession.create({
    data: { unitId: unit.id, date: TOM, startTime: shift(now, -13), endTime: shift(now, 107), description: "qr tomorrow" },
  });
  made.sessions.push(tomSess.id);

  const otherDay = await call(`/hnd/my-sessions/today?date=${TOM}`, { token: tutorToken });
  check("a lecturer can ask about another day", otherDay.status === 200, `HTTP ${otherDay.status}`);
  check("and the server says it is NOT today, so nothing on screen claims to be live",
    otherDay.data?.isToday === false && otherDay.data?.date === TOM,
    `isToday=${otherDay.data?.isToday} date=${otherDay.data?.date}`);
  check("tomorrow's class IS on the list, so the next check is not vacuous",
    (otherDay.data?.sessions || []).some((x) => x.id === tomSess.id),
    `n=${(otherDay.data?.sessions || []).length}`);
  check("NO CLASS ON ANOTHER DAY IS EVER 'ACCEPTING TAPS' — the wall clock is today's",
    (otherDay.data?.sessions || []).length > 0
      && (otherDay.data?.sessions || []).every((x) => x.acceptingTaps === false),
    JSON.stringify((otherDay.data?.sessions || []).map((x) => x.acceptingTaps)));
  const otherDayAll = await call(`/hnd/my-sessions/today?date=${TOM}&scope=all`, { token: tutorToken });
  check("A DATE DOES NOT BECOME A WAY ROUND THE SCOPE GATE", otherDayAll.status === 403, `HTTP ${otherDayAll.status}`);
  const badDay = await call("/hnd/my-sessions/today?date=2026-02-31", { token: tutorToken });
  check("a date that is not a real day is REFUSED, not quietly answered about today",
    badDay.status === 400, `HTTP ${badDay.status} ${badDay.data?.error || ""}`);
  const todayAgain = await call("/hnd/my-sessions/today", { token: tutorToken });
  check("omitting the date still means today", todayAgain.data?.isToday === true, `isToday=${todayAgain.data?.isToday}`);

  // --- a RANGE, not just a day ---
  //
  // "How did last week go" and "is next week's timetable actually there" were both
  // unanswerable. The range must SPAN — a range that quietly returned only its first day
  // would look right on a screen showing one class and be wrong on every other.
  const span = await call(`/hnd/my-sessions/today?date=${todayLocal()}&to=${TOM}`, { token: tutorToken });
  check("a range answers", span.status === 200, `HTTP ${span.status}`);
  check("and echoes back its end, so the screen cannot label a week as a day",
    span.data?.to === TOM && span.data?.date === todayLocal(), `${span.data?.date}..${span.data?.to}`);
  check("IT SPANS — today's class AND tomorrow's are both on the list",
    (span.data?.sessions || []).some((x) => x.id === tutorSess.id)
      && (span.data?.sessions || []).some((x) => x.id === tomSess.id),
    `n=${(span.data?.sessions || []).length}`);
  check("every row carries its own date, or a fortnight of one lecture is identical lines",
    (span.data?.sessions || []).every((x) => typeof x.date === "string" && x.date.length === 10),
    JSON.stringify((span.data?.sessions || []).map((x) => x.date)));
  // A RANGE IS NEVER "TODAY", even one containing it: everything gated on isToday says
  // "right now", and a week is not a moment.
  check("A RANGE IS NOT 'TODAY', even when it contains today", span.data?.isToday === false, `isToday=${span.data?.isToday}`);
  check("so nothing in a range is advertised as accepting taps",
    (span.data?.sessions || []).every((x) => x.acceptingTaps === false),
    JSON.stringify((span.data?.sessions || []).map((x) => x.acceptingTaps)));

  const backwards = await call(`/hnd/my-sessions/today?date=${TOM}&to=${todayLocal()}`, { token: tutorToken });
  check("an end before the start is refused", backwards.status === 400, `HTTP ${backwards.status} ${backwards.data?.error || ""}`);
  const tooWide = await call(`/hnd/my-sessions/today?date=2027-01-01&to=2027-12-31`, { token: tutorToken });
  check("A YEAR IS REFUSED — this handler reads every register in the range and their marks",
    tooWide.status === 400, `HTTP ${tooWide.status} ${tooWide.data?.error || ""}`);
  const termWide = await call(`/hnd/my-sessions/today?date=2027-01-01&to=2027-03-01`, { token: tutorToken });
  check("but a term-sized range is allowed, so the cap is not merely obstructive",
    termWide.status === 200, `HTTP ${termWide.status}`);
  const spanAll = await call(`/hnd/my-sessions/today?date=${todayLocal()}&to=${TOM}&scope=all`, { token: tutorToken });
  check("A RANGE DOES NOT BECOME A WAY ROUND THE SCOPE GATE EITHER", spanAll.status === 403, `HTTP ${spanAll.status}`);

  const tutorMint = await call(`/hnd/sessions/${tutorSess.id}/qr-code`, { token: tutorToken });
  check("the tutor can put their own class's code on the screen",
    tutorMint.status === 200 && typeof tutorMint.data?.code === "string" && tutorMint.data.code.length === CODE_LENGTH,
    `HTTP ${tutorMint.status}`);
  const tutorLive = await call(`/hnd/sessions/${tutorSess.id}/live`, { token: tutorToken });
  check("the tutor can watch their own register fill", tutorLive.status === 200 && Array.isArray(tutorLive.data?.rows), `HTTP ${tutorLive.status}`);
  check("and is told they may close it", tutorLive.data?.canClose === true, `canClose=${tutorLive.data?.canClose}`);
  check("the live view says which check-in methods are on, for the banner",
    tutorLive.data?.qrEnabled === true && tutorLive.data?.tapEnabled === false,
    `qrEnabled=${tutorLive.data?.qrEnabled} tapEnabled=${tutorLive.data?.tapEnabled}`);

  const nonTutorMint = await call(`/hnd/sessions/${tutorSess.id}/qr-code`, { token: otherToken });
  const nonTutorLive = await call(`/hnd/sessions/${tutorSess.id}/live`, { token: otherToken });
  check("a member of staff who does not teach the unit gets neither the code nor the register",
    nonTutorMint.status === 403 && nonTutorLive.status === 403, `mint ${nonTutorMint.status} live ${nonTutorLive.status}`);
  const nonTutorClose = await call(`/hnd/sessions/${tutorSess.id}/mark-remaining-absent`, { method: "POST", token: otherToken });
  check("nor can they close it", nonTutorClose.status === 403, `HTTP ${nonTutorClose.status}`);

  const tutorStudents = await call("/hnd/students", { token: tutorToken });
  const tutorUnits = await call("/hnd/units", { token: tutorToken });
  const tutorRegister = await call(`/hnd/sessions/${tutorSess.id}/register`, { token: tutorToken });
  check("the door is four routes wide: the directory, the units and the paper register stay shut to the tutor",
    tutorStudents.status === 403 && tutorUnits.status === 403 && tutorRegister.status === 403,
    `students ${tutorStudents.status} units ${tutorUnits.status} register ${tutorRegister.status}`);

  const tutorClose = await call(`/hnd/sessions/${tutorSess.id}/mark-remaining-absent`, { method: "POST", token: tutorToken });
  const closedMarks = await db.attendanceMark.findMany({ where: { sessionId: tutorSess.id } });
  for (const m of closedMarks) made.marks.push(m.id);
  check("the tutor can close their own register, and the absences carry their name",
    tutorClose.status === 200 && tutorClose.data?.marked === 2
      && closedMarks.length === 2 && closedMarks.every((m) => m.status === "A" && m.takenBy === TUTOR_NAME),
    `HTTP ${tutorClose.status} marked=${tutorClose.data?.marked} rows=${closedMarks.length} takenBy=${closedMarks[0]?.takenBy}`);

  // An administrator granted the WATCHING page alone. The page exists so a college can
  // grant watching without editing; the screen must therefore not offer a close button
  // that only ever answers 403.
  const watcher = await db.staff.create({ data: {
    name: `Watcher ${RUN}`, jobTitle: "Administrator", dept: "Administration",
    email: `watcher-${RUN}@smoke.test`, passwordHash: bcrypt.hashSync(S_PASSWORD, 10),
    accountRole: "ADMIN", adminPages: JSON.stringify(["live-attendance"]), initials: "WA", colour: "#334155",
  } });
  made.staff.push(watcher.id);
  const watcherToken = (await login(watcher.email, S_PASSWORD)).data?.token;
  const watcherLive = await call(`/hnd/sessions/${live.id}/live`, { token: watcherToken });
  const watcherClose = await call(`/hnd/sessions/${live.id}/mark-remaining-absent`, { method: "POST", token: watcherToken });
  check("an administrator granted only the watching page sees the register but is told not to offer the close button",
    watcherLive.status === 200 && watcherLive.data?.canClose === false && watcherClose.status === 403,
    `live ${watcherLive.status} canClose=${watcherLive.data?.canClose} close ${watcherClose.status}`);

  /* ====================================================================== */
  console.log("\n--- the OTHER answer to \"who teaches this class\" ---");
  /* ====================================================================== */

  // Unit.tutorStaffId is the term-long role. TimetableEventStaff is the per-EVENT
  // assignment, and registers built from the timetable carry HndSession.timetableEventId
  // back to it. A visiting lecturer, a cover, or the second of two staff on a merged
  // class is named on the event and tutors nothing — and until 9 Sep 2026 they opened
  // this dashboard, were told "No classes of yours today", and were advised to ask an
  // administrator to make them the tutor of somebody else's module.
  //
  // The fixture is deliberately the SAME account the block above proved sees nothing:
  // s2 tutors no unit and holds no admin page, this unit's tutor is s1, and the only
  // thing that changes is one row in TimetableEventStaff.
  const ttEvent = await db.timetableEvent.create({ data: {
    date: today, startTime: shift(now, -20), endTime: shift(now, 100),
    title: `Timetabled ${RUN}`, unitId: unit.id, published: true,
    staff: { create: [{ staffId: OTHER_ID }] },
  } });
  made.events.push(ttEvent.id);
  const ttSess = await db.hndSession.create({ data: {
    unitId: unit.id, date: today, startTime: shift(now, -20), endTime: shift(now, 100),
    description: "qr timetabled", timetableEventId: ttEvent.id,
  } });
  made.sessions.push(ttSess.id);

  const namedToday = await call("/hnd/my-sessions/today", { token: otherToken });
  const namedIds = (namedToday.data?.sessions || []).map((x) => x.id);
  check("A LECTURER NAMED ON THE TIMETABLED CLASS SEES IT, THOUGH THEY TUTOR NO UNIT",
    namedToday.status === 200 && namedToday.data?.teaches === true && namedIds.includes(ttSess.id),
    `HTTP ${namedToday.status} teaches=${namedToday.data?.teaches} ids=${namedIds.join(",")}`);
  // The tightening half. Being named on ONE event is not being given the unit: the
  // tutor's other registers on the very same unit must stay out of this list, or the
  // fix has quietly turned a per-class assignment into a per-module grant.
  check("and only THAT class — the tutor's other registers on the same unit stay theirs",
    !namedIds.includes(tutorSess.id) && !namedIds.includes(live.id),
    `ids=${namedIds.join(",")}`);
  check("being named on one class does not offer them the whole college",
    namedToday.data?.canSeeAll === false && (await call("/hnd/my-sessions/today?scope=all", { token: otherToken })).status === 403,
    `canSeeAll=${namedToday.data?.canSeeAll}`);

  // A member of staff who is NEITHER the unit's tutor NOR named on the event. s3 is a
  // seeded STAFF account with no admin pages; whatever else they may teach, this class
  // is not theirs and neither is the tutor's.
  const strangerToken = (await login("d.okoye@edtech.co.uk", SEED_PASSWORD)).data?.token;
  const strangerToday = await call("/hnd/my-sessions/today", { token: strangerToken });
  const strangerIds = (strangerToday.data?.sessions || []).map((x) => x.id);
  check("a lecturer who is neither the tutor nor named on the class sees neither register",
    strangerToday.status === 200 && !strangerIds.includes(ttSess.id) && !strangerIds.includes(tutorSess.id),
    `HTTP ${strangerToday.status} ids=${strangerIds.join(",")}`);

  // The door has to open too, or the list is a row of classes that all answer 403.
  const namedLive = await call(`/hnd/sessions/${ttSess.id}/live`, { token: otherToken });
  const namedOtherLive = await call(`/hnd/sessions/${tutorSess.id}/live`, { token: otherToken });
  check("the named lecturer can open THAT register and still not the tutor's",
    namedLive.status === 200 && namedLive.data?.canClose === true && namedOtherLive.status === 403,
    `live ${namedLive.status} canClose=${namedLive.data?.canClose} other ${namedOtherLive.status}`);
  const strangerLive = await call(`/hnd/sessions/${ttSess.id}/live`, { token: strangerToken });
  check("and a lecturer named on nothing is still refused the register itself",
    strangerLive.status === 403, `HTTP ${strangerLive.status}`);

  /* ====================================================================== */
  console.log("\n--- the day's counts, and what N/A is not ---");
  /* ====================================================================== */

  // P / L / E / A are marks somebody made. "Not marked" is the roster minus them, and it
  // is UNMEASURED rather than absent — the dashboard's whole reason for existing is that
  // nothing turns an unmarked student into an A without a named human pressing a button.
  const countsToday = await call("/hnd/my-sessions/today", { token: tutorToken });
  const rowFor = (id) => (countsToday.data?.sessions || []).find((x) => x.id === id);
  const closedRow = rowFor(tutorSess.id);
  check("each class on the list carries its own P/L/E/A breakdown",
    closedRow?.counts?.A === 2 && closedRow.counts.P === 0 && closedRow.counts.L === 0 && closedRow.counts.E === 0,
    JSON.stringify(closedRow?.counts));
  check("a register just closed has nobody left unmarked",
    closedRow?.counts?.notMarked === 0 && closedRow?.counts?.roster === 2, JSON.stringify(closedRow?.counts));
  const ttRow = rowFor(ttSess.id);
  check("AN UNTOUCHED REGISTER'S STUDENTS ARE NOT MARKED, NOT ABSENT",
    ttRow?.counts?.notMarked === 2 && ttRow.counts.A === 0 && ttRow.counts.P === 0,
    JSON.stringify(ttRow?.counts));

  // NULL IS NOT ZERO. A unit with no enrolment rows is a register nobody can size — a
  // Moodle import that never synced enrolments is the ordinary cause — and "0 not
  // marked" there tells a lecturer everybody is accounted for on a class that has no
  // roster at all.
  const emptyUnit = await db.unit.create({ data: { ...stamp(DEPT), code: `QRE${RUN}`.slice(0, 12), name: `QR Empty Unit ${RUN}`, startDate: today, endDate: today, tutorStaffId: TUTOR_ID } });
  made.units.push(emptyUnit.id);
  const emptySess = await db.hndSession.create({ data: { unitId: emptyUnit.id, date: today, startTime: shift(now, -25), endTime: shift(now, 95), description: "qr no roster" } });
  made.sessions.push(emptySess.id);
  const withEmpty = await call("/hnd/my-sessions/today", { token: tutorToken });
  const emptyRow = (withEmpty.data?.sessions || []).find((x) => x.id === emptySess.id);
  check("a register with no roster reports NULL not-marked, never 0",
    emptyRow?.counts?.notMarked === null && emptyRow?.counts?.roster === null,
    JSON.stringify(emptyRow?.counts));
  check("and the day's total is the sum of exactly the rows on the list",
    withEmpty.data?.totals?.A === (withEmpty.data.sessions || []).reduce((n, x) => n + (x.counts?.A || 0), 0)
      && withEmpty.data?.totals?.notMarked
        === (withEmpty.data.sessions || []).reduce((n, x) => n + (x.counts?.notMarked ?? 0), 0),
    JSON.stringify(withEmpty.data?.totals));

  // A register the Moodle importer created is an HndSession like any other, so the
  // screen mints for it without anybody doing anything. Asserted so the claim in the
  // handoff — "imported classes are covered automatically" — is a test, not a sentence.
  const imported = await db.hndSession.create({ data: { unitId: unit.id, date: today, startTime: shift(now, -17), endTime: shift(now, 103), description: "Imported from Moodle", moodleSessionId: 987654321 } });
  made.sessions.push(imported.id);
  const importedMint = await call(`/hnd/sessions/${imported.id}/qr-code`, { token: adminToken });
  check("a class imported from Moodle mints a code like any other",
    importedMint.status === 200 && typeof importedMint.data?.code === "string", `HTTP ${importedMint.status}`);

  // ---- The academic department boundary, on the code itself ----------------------
  //
  // Since 4 Sep 2026 a member of staff can be narrowed to one or more academic
  // departments, and the guarded Prisma client then hides every other department's
  // classes from them. The mint reads the session through that client, so a narrowed
  // administrator asking for another department's code gets "not found" — and that has
  // to be asserted rather than inferred, because it is the one path a college-wide test
  // account can never take. Built here with two real departments and an account narrowed
  // to one of them, so it holds in the ordinary pass AND the scoped pass.
  const deptA = await db.academicDepartment.create({ data: { key: `qr-a-${RUN}`, name: `QR Suite Dept A ${RUN}` } });
  const deptB = await db.academicDepartment.create({ data: { key: `qr-b-${RUN}`, name: `QR Suite Dept B ${RUN}` } });
  made.departments.push(deptA.id, deptB.id);
  const narrowed = await db.staff.create({ data: {
    name: `Narrowed ${RUN}`, jobTitle: "Administrator", dept: "Administration",
    email: `narrowed-${RUN}@smoke.test`, passwordHash: bcrypt.hashSync(S_PASSWORD, 10),
    accountRole: "ADMIN", adminPages: JSON.stringify(["registers", "live-attendance"]), initials: "NA", colour: "#334155",
    collegeWide: false, academicDepartments: { create: { academicDepartmentId: deptA.id } },
  } });
  made.staff.push(narrowed.id);
  const narrowedToken = (await login(narrowed.email, S_PASSWORD)).data?.token;
  const unitA = await db.unit.create({ data: { code: `QRDA${RUN}`.slice(0, 12), name: `QR Dept A Unit ${RUN}`, startDate: today, endDate: today, academicDepartmentId: deptA.id } });
  const unitB = await db.unit.create({ data: { code: `QRDB${RUN}`.slice(0, 12), name: `QR Dept B Unit ${RUN}`, startDate: today, endDate: today, academicDepartmentId: deptB.id } });
  made.units.push(unitA.id, unitB.id);
  const liveA = await db.hndSession.create({ data: { unitId: unitA.id, date: today, startTime: shift(now, -3), endTime: shift(now, 117), description: "qr dept a" } });
  const liveB = await db.hndSession.create({ data: { unitId: unitB.id, date: today, startTime: shift(now, -3), endTime: shift(now, 117), description: "qr dept b" } });
  made.sessions.push(liveA.id, liveB.id);

  const ownMint = await call(`/hnd/sessions/${liveA.id}/qr-code`, { token: narrowedToken });
  check("an administrator narrowed to a department can put their own department's code on the screen",
    ownMint.status === 200 && typeof ownMint.data?.code === "string", `HTTP ${ownMint.status}`);
  const otherMint = await call(`/hnd/sessions/${liveB.id}/qr-code`, { token: narrowedToken });
  const foreignLive = await call(`/hnd/sessions/${liveB.id}/live`, { token: narrowedToken });
  check("and cannot mint, or even see, another department's class",
    otherMint.status === 404 && !otherMint.data?.code && foreignLive.status === 404,
    `mint ${otherMint.status} live ${foreignLive.status}`);
  // Breaks if: the mint route's session read ever moves to an unguarded client, or the
  // narrowed account's own department is filtered out — the two ways the boundary fails.

  // The boundary is between MEMBERS OF STAFF. A student belongs to the class they are
  // enrolled on, whichever department it sits in, and their scan must never be caught by
  // a wall that exists to keep one administrator out of another's registers.
  const enrolB = await db.enrolment.create({ data: { studentId: QE_ID, unitId: unitB.id } });
  made.enrolments.push(enrolB.id);
  const scanB = await call("/student/me/qr-check-in", { method: "POST", token: qeToken, body: { sessionId: liveB.id, code: codeFor(liveB.id) } });
  if (scanB.status === 201) made.marks.push((await db.attendanceMark.findFirst({ where: { sessionId: liveB.id, studentId: QE_ID }, select: { id: true } }))?.id);
  check("a student's scan is never blocked by the department boundary",
    scanB.status === 201 && scanB.data?.status === "P", `HTTP ${scanB.status} ${scanB.data?.reason || ""}`);

  // ---- The mint and the scan agree at the EDGES of the window ---------------------
  //
  // attendanceTap.js says the mint and the scan MUST agree to the minute, and the shared
  // predicate is the mechanism — but until now the only PAIRED assertion was the closed
  // term. The historic bug that predicate exists for was a projector advertising a code
  // the server refused, and it lived exactly at these edges: just before the start,
  // inside the early-grace window, and the grace setting itself, which this suite had
  // pinned at zero for the whole run. Three pairs, with a real grace of ten minutes.
  const graceOn = await call("/tags/settings", { method: "PUT", token: adminToken, body: { earlyGraceMins: 10 } });
  check("an administrator can let students check in before the class starts",
    graceOn.status === 200 && graceOn.data?.earlyGraceMins === 10, `HTTP ${graceOn.status} earlyGraceMins=${graceOn.data?.earlyGraceMins}`);
  const soon = await db.hndSession.create({ data: { unitId: unit.id, date: today, startTime: shift(now, 5), endTime: shift(now, 125), description: "qr in grace" } });
  const later = await db.hndSession.create({ data: { unitId: unit.id, date: today, startTime: shift(now, 30), endTime: shift(now, 150), description: "qr before grace" } });
  made.sessions.push(soon.id, later.id);
  for (const sid of [QE_ID, QF_ID]) {
    const e = await db.enrolment.create({ data: { studentId: sid, unitId: unit.id } });
    made.enrolments.push(e.id);
  }

  const mintSoon = await call(`/hnd/sessions/${soon.id}/qr-code`, { token: adminToken });
  const scanSoon = await call("/student/me/qr-check-in", { method: "POST", token: qeToken, body: { sessionId: soon.id, code: codeFor(soon.id) } });
  if (scanSoon.status === 201) made.marks.push((await db.attendanceMark.findFirst({ where: { sessionId: soon.id, studentId: QE_ID }, select: { id: true } }))?.id);
  check("inside the grace window the screen has a code, says when it opened, and a scan is marked Present",
    mintSoon.status === 200 && typeof mintSoon.data?.code === "string" && mintSoon.data?.phase === "open"
      && mintSoon.data?.opensAt === shift(soon.startTime, -10) && scanSoon.status === 201 && scanSoon.data?.status === "P",
    `mint ${mintSoon.status} phase=${mintSoon.data?.phase} opensAt=${mintSoon.data?.opensAt} scan ${scanSoon.status} ${scanSoon.data?.status || scanSoon.data?.reason || ""}`);

  const mintLater = await call(`/hnd/sessions/${later.id}/qr-code`, { token: adminToken });
  const scanLater = await call("/student/me/qr-check-in", { method: "POST", token: qeToken, body: { sessionId: later.id, code: codeFor(later.id) } });
  check("before the grace window the screen has NO code and says when it opens, and a scan is refused as not running",
    mintLater.status === 200 && mintLater.data?.code === null && mintLater.data?.phase === "before"
      && mintLater.data?.opensAt === shift(later.startTime, -10) && scanLater.status === 409 && scanLater.data?.reason === "no_session_now",
    `mint ${mintLater.status} code=${mintLater.data?.code} phase=${mintLater.data?.phase} scan ${scanLater.status} ${scanLater.data?.reason || ""}`);

  // Breaks if: either side stops reading earlyGraceMins, or reads it from a different
  // place than the other. Grace back to zero, and the same class is "before" for both.
  const graceOff = await call("/tags/settings", { method: "PUT", token: adminToken, body: { earlyGraceMins: 0 } });
  const mintSoonNoGrace = await call(`/hnd/sessions/${soon.id}/qr-code`, { token: adminToken });
  const scanSoonNoGrace = await call("/student/me/qr-check-in", { method: "POST", token: qfToken, body: { sessionId: soon.id, code: codeFor(soon.id) } });
  check("with the grace removed, the same class is not yet open on the screen AND at the scan",
    graceOff.status === 200 && mintSoonNoGrace.data?.code === null && mintSoonNoGrace.data?.phase === "before"
      && scanSoonNoGrace.status === 409 && scanSoonNoGrace.data?.reason === "no_session_now",
    `mint code=${mintSoonNoGrace.data?.code} phase=${mintSoonNoGrace.data?.phase} scan ${scanSoonNoGrace.status} ${scanSoonNoGrace.data?.reason || ""}`);

  // The Registers page needs to know whether to offer a "QR code" action on each session
  // at all — a button that only ever leads to "switched off" is a dead end.
  const settingsAdmin = await call("/hnd/check-in-settings", { token: adminToken });
  const settingsTutor = await call("/hnd/check-in-settings", { token: tutorToken });
  check("the registers page can ask which check-in methods are on",
    settingsAdmin.status === 200 && settingsAdmin.data?.qrEnabled === true && settingsAdmin.data?.tapEnabled === false,
    `HTTP ${settingsAdmin.status} ${JSON.stringify(settingsAdmin.data)}`);
  check("and that read stays behind the admin gate", settingsTutor.status === 403, `HTTP ${settingsTutor.status}`);


  /* ====================================================================== */
  console.log("\n--- the lecturer's hand on the window ---");
  /* ====================================================================== */

  // The timetable opens and closes check-in on its own; these two buttons are the
  // lecturer overriding it for one class on one day: end it early, or hold it open for
  // the stragglers. Both flow through the one window predicate, so the code, the badge
  // and the scan all agree the moment the button is pressed.
  const winPath = (id) => `/hnd/sessions/${id}/check-in-window`;
  const closeByOther = await call(winPath(tutorSess.id), { method: "POST", token: otherToken, body: { action: "close" } });
  const closeByWatcher = await call(winPath(tutorSess.id), { method: "POST", token: watcherToken, body: { action: "close" } });
  check("only the tutor or a registers admin can end check-in early",
    closeByOther.status === 403 && closeByWatcher.status === 403, `other ${closeByOther.status} watcher ${closeByWatcher.status}`);

  const closed = await call(winPath(tutorSess.id), { method: "POST", token: tutorToken, body: { action: "close" } });
  check("the tutor can end check-in before the timetabled end",
    closed.status === 200 && Boolean(closed.data?.checkInClosedAt) && closed.data?.acceptingTaps === false,
    `HTTP ${closed.status} closedAt=${closed.data?.checkInClosedAt} accepting=${closed.data?.acceptingTaps}`);
  const mintClosed = await call(`/hnd/sessions/${tutorSess.id}/qr-code`, { token: tutorToken });
  check("the screen then gets no code and is told the lecturer closed it",
    mintClosed.status === 200 && mintClosed.data?.code === null && mintClosed.data?.phase === "ended",
    `HTTP ${mintClosed.status} code=${mintClosed.data?.code} phase=${mintClosed.data?.phase}`);
  const scanClosed = await call("/student/me/qr-check-in", { method: "POST", token: qcToken, body: { sessionId: tutorSess.id, code: codeFor(tutorSess.id) } });
  check("a scan against a class the lecturer has closed is refused as not running",
    scanClosed.status === 409 && scanClosed.data?.reason === "no_session_now", `HTTP ${scanClosed.status} reason=${scanClosed.data?.reason}`);
  const liveClosed = await call(`/hnd/sessions/${tutorSess.id}/live`, { token: tutorToken });
  check("the live view names the phase and today's date, so the screen can offer reopen only where it applies",
    liveClosed.data?.phase === "ended" && liveClosed.data?.today === today,
    `phase=${liveClosed.data?.phase} today=${liveClosed.data?.today}`);
  const todayClosed = await call("/hnd/my-sessions/today", { token: tutorToken });
  check("and the day's list stops calling it open",
    (todayClosed.data?.sessions || []).find((x) => x.id === tutorSess.id)?.acceptingTaps === false, "");

  const badMinutes = await call(winPath(tutorSess.id), { method: "POST", token: tutorToken, body: { action: "reopen", minutes: 999 } });
  const badAction = await call(winPath(tutorSess.id), { method: "POST", token: tutorToken, body: { action: "nonsense" } });
  check("an unusable reopen is refused rather than guessed at", badMinutes.status === 400 && badAction.status === 400, `minutes ${badMinutes.status} action ${badAction.status}`);

  const reopened = await call(winPath(tutorSess.id), { method: "POST", token: tutorToken, body: { action: "reopen", minutes: 10 } });
  check("the tutor can reopen it, and the close is gone",
    reopened.status === 200 && reopened.data?.checkInClosedAt === null && /^\d{2}:\d{2}$/.test(reopened.data?.checkInOpenUntil || "") && reopened.data?.acceptingTaps === true,
    `HTTP ${reopened.status} closedAt=${reopened.data?.checkInClosedAt} until=${reopened.data?.checkInOpenUntil} accepting=${reopened.data?.acceptingTaps}`);
  const mintAgain = await call(`/hnd/sessions/${tutorSess.id}/qr-code`, { token: tutorToken });
  check("and the code is back on the screen", mintAgain.status === 200 && typeof mintAgain.data?.code === "string", `HTTP ${mintAgain.status}`);

  // Holding a FINISHED class open for late arrivals: the one that ended an hour ago.
  const scanPastBefore = await call("/student/me/qr-check-in", { method: "POST", token: qcToken, body: { sessionId: past.id, code: codeFor(past.id) } });
  check("a finished class refuses a scan, as before", scanPastBefore.status === 409 && scanPastBefore.data?.reason === "no_session_now", `HTTP ${scanPastBefore.status}`);
  const held = await call(winPath(past.id), { method: "POST", token: tutorToken, body: { action: "reopen", minutes: 15 } });
  check("the tutor can hold a finished class open for a quarter of an hour",
    held.status === 200 && held.data?.acceptingTaps === true && held.data?.checkInOpenUntil > now,
    `HTTP ${held.status} until=${held.data?.checkInOpenUntil} now=${now}`);
  const mintHeld = await call(`/hnd/sessions/${past.id}/qr-code`, { token: tutorToken });
  check("the screen mints for it and says when the held-open window closes",
    mintHeld.status === 200 && typeof mintHeld.data?.code === "string" && mintHeld.data?.closesAt === held.data?.checkInOpenUntil,
    `HTTP ${mintHeld.status} closesAt=${mintHeld.data?.closesAt}`);
  const scanPast = await call("/student/me/qr-check-in", { method: "POST", token: qcToken, body: { sessionId: past.id, code: codeFor(past.id) } });
  const pastMark = await db.attendanceMark.findFirst({ where: { sessionId: past.id, studentId: QC_ID } });
  if (pastMark) made.marks.push(pastMark.id);
  check("a late arrival scanning inside the held-open window is marked, and marked Late",
    scanPast.status === 201 && scanPast.data?.status === "L" && pastMark?.status === "L",
    `HTTP ${scanPast.status} status=${scanPast.data?.status}`);

  /* ====================================================================== */
  console.log("\n--- the device trail ---");
  /* ====================================================================== */

  // The app sends an id it made up once. It proves nothing about who is holding the
  // phone — the account does that — but it is the trail an administrator follows when
  // one handset appears to have scanned for half a seminar group.
  const withDevice = await call("/student/me/qr-check-in", { method: "POST", token: qcToken, headers: { "X-Device-Id": "dev-suite-abc" }, body: { sessionId: tutorSess.id, code: codeFor(tutorSess.id) } });
  const devRow = await db.tagTap.findFirst({ where: { studentId: QC_ID, method: "qr" }, orderBy: { at: "desc" } });
  check("a scan's log row records the device the app identified itself as",
    withDevice.status === 200 && devRow?.deviceId === "dev-suite-abc", `HTTP ${withDevice.status} deviceId=${devRow?.deviceId}`);
  const junkDevice = "x".repeat(200) + "<script>";
  await call("/student/me/qr-check-in", { method: "POST", token: qcToken, headers: { "X-Device-Id": junkDevice }, body: { sessionId: tutorSess.id, code: codeFor(tutorSess.id) } });
  const junkRow = await db.tagTap.findFirst({ where: { studentId: QC_ID, method: "qr" }, orderBy: { at: "desc" } });
  check("a device id is cut to size and stripped of anything but id characters",
    typeof junkRow?.deviceId === "string" && junkRow.deviceId.length <= 64 && /^[A-Za-z0-9_-]+$/.test(junkRow.deviceId),
    `stored=${String(junkRow?.deviceId).slice(0, 70)}`);



  /* ====================================================================== */
  console.log("\n--- the lecturer still owns the register ---");
  /* ====================================================================== */

  // The other half of "a scan cannot overwrite a lecturer's mark". That rule protects the
  // human in the room; it must not have accidentally made a scanned mark UNCORRECTABLE,
  // which would be worse — a student wrongly marked by a code they scanned in the corridor
  // with no way for the tutor to put it right. Staff authority wins, and the arrival time
  // survives the correction because the student did arrive; only the judgement changes.
  const beforeFix = await db.attendanceMark.findFirst({ where: { sessionId: live.id, studentId: QA_ID } });
  check("the scanned mark is on file before the correction",
    beforeFix?.status === "P" && beforeFix?.takenBy === "Self check-in (QR)",
    `status=${beforeFix?.status} takenBy=${beforeFix?.takenBy}`);

  const correction = await call(`/hnd/sessions/${live.id}/register`, {
    method: "PUT", token: adminToken,
    body: { marks: [{ studentId: QA_ID, status: "E", remark: "left early, agreed with tutor" }] },
  });
  const afterFix = await db.attendanceMark.findFirst({ where: { sessionId: live.id, studentId: QA_ID } });
  check("a lecturer CAN correct a mark a student scanned",
    correction.status === 200 && afterFix?.status === "E",
    `HTTP ${correction.status} status=${afterFix?.status}`);
  check("and the corrected mark is attributed to the member of staff, not to the code",
    afterFix?.takenBy && afterFix.takenBy !== "Self check-in (QR)", `takenBy=${afterFix?.takenBy}`);
  check("while the minute the student actually arrived survives the correction",
    afterFix?.checkedInAt === beforeFix?.checkedInAt && !!afterFix?.checkedInAt,
    `before=${beforeFix?.checkedInAt} after=${afterFix?.checkedInAt}`);

  // And the corrected register is not a door back in: the student cannot scan again to
  // undo the tutor's decision.
  const rescanAfterFix = await call("/student/me/qr-check-in", { method: "POST", token: qaToken, body: { sessionId: live.id, code: codeFor(live.id) } });
  const stillFixed = await db.attendanceMark.findFirst({ where: { sessionId: live.id, studentId: QA_ID } });
  check("and the student cannot scan their way back over the tutor's correction",
    stillFixed?.status === "E", `status=${stillFixed?.status} (scan answered HTTP ${rescanAfterFix.status})`);

  /* ====================================================================== */
  console.log("\n--- the paper register says HOW each mark got there ---");
  /* ====================================================================== */

  // The register endpoint is what an administrator reading a DISPUTED register is served,
  // and it shipped `takenBy` alone — so the screen either ignored provenance entirely or
  // had to re-derive "is this a self check-in" from a string the browser is not the
  // authority on. The live view has carried `selfMarked` from the shared predicate for a
  // while; this asserts the register agrees with it, because the failure that matters is
  // not "neither screen shows it", it is the two screens saying different things about
  // the same mark.
  //
  // This register is the ideal place to ask, because the corrections above have left it
  // holding all three cases at once, made by the real routes rather than seeded: QA was
  // scanned and then OVERWRITTEN by an administrator, QC scanned and was never touched,
  // and QE is enrolled on the unit and was never marked on this session at all.
  // A FOURTH case, and the only one that has to be planted: a mark carrying the NFC
  // stamp. NFC tap check-in is switched OFF for this entire suite on purpose — that is
  // half of what it proves — so no route in this run can write one, and yet "qr" and
  // "nfc" are exactly the two answers that must not be confused with each other. Planted
  // through the bare client, the same way the lecturer's A is planted above.
  //
  // QF is enrolled on this unit and has no mark on this session, so this adds a row
  // rather than disturbing one an assertion above already reasoned about.
  const nfcMark = await db.attendanceMark.create({
    data: { sessionId: live.id, studentId: QF_ID, status: "P", remark: "", takenBy: "Self check-in (NFC)", checkedInAt: now },
  });
  made.marks.push(nfcMark.id);

  const reg = await call(`/hnd/sessions/${live.id}/register`, { token: adminToken });
  const regRow = (id) => reg.data?.rows?.find((r) => r.student?.id === id);
  const regQa = regRow(QA_ID), regQc = regRow(QC_ID), regQe = regRow(QE_ID);
  check("the register lists the scanned, the corrected and the unmarked student",
    reg.status === 200 && !!regQa && !!regQc && !!regQe,
    `HTTP ${reg.status} rows=${reg.data?.rows?.length ?? "none"}`);

  check("a mark the student scanned is reported as a self check-in on the register too",
    regQc?.selfMarked === true, `selfMarked=${regQc?.selfMarked} takenBy=${regQc?.takenBy}`);

  // WHICH self check-in, not merely THAT it was one. A sticker in the room and a code on
  // a projector have different failure modes — one needs physical proximity, the other can
  // be photographed — so the stamp has to survive to the screen intact, or the register
  // can say "the student did this" without being able to say how they could have.
  check("and names the method, so a sticker and a code on screen stay distinguishable",
    regQc?.takenBy === "Self check-in (QR)", `takenBy=${regQc?.takenBy}`);

  // The discriminating half. If `selfMarked` were hardcoded, copied from `status`, or
  // derived from anything other than the stamp, this is the assertion that notices: the
  // administrator's correction is on the SAME register, in the same shape, and differs
  // only in who made it.
  check("a mark a member of staff made is NOT reported as a self check-in",
    regQa?.selfMarked === false && !!regQa?.takenBy && regQa.takenBy !== "Self check-in (QR)",
    `selfMarked=${regQa?.selfMarked} takenBy=${regQa?.takenBy}`);

  // Null is "not recorded", never "a member of staff did it". A student nobody has marked
  // must not be attributed to anybody — a register that quietly credits an unmarked row to
  // staff is the same untruth as one that credits it to the student.
  check("a student nobody has marked is neither self-marked nor attributed to anyone",
    regQe?.status === null && regQe?.selfMarked === false && regQe?.takenBy === null,
    `status=${regQe?.status} selfMarked=${regQe?.selfMarked} takenBy=${regQe?.takenBy}`);

  /* ====================================================================== */
  console.log("\n--- and says WHICH self check-in, in a token no wording can move ---");
  /* ====================================================================== */

  // `takenBy` is prose: frozen English, written into rows in two live databases, and the
  // thing an administrator reads. Both browser screens used to derive the CAPTURE METHOD
  // from it by comparing against the literal "Self check-in (QR)" — so the exact string
  // lived in three files, and rewording it would have relabelled every scanned mark as a
  // sticker tap on the screens read when a mark is DISPUTED, with nothing failing.
  //
  // `checkInMethod` is the fix: "qr" | "nfc" | null, derived on the server from the same
  // map `isSelfCheckIn` reads. These assertions are about the TOKEN, deliberately never
  // about the prose beside it — a test that checked both would be the third copy again.
  //
  // Four cases, on all three endpoints that carry `selfMarked`, because a register, a live
  // view and a student's history disagreeing about one mark is worse than none of them
  // showing it: QC scanned a code, QF's mark carries the sticker stamp, QA's was made by
  // an administrator, and QE has no mark at all.
  const regQf = regRow(QF_ID);
  check("the register reports a scanned mark as the qr method",
    regQc?.checkInMethod === "qr", `checkInMethod=${regQc?.checkInMethod}`);
  check("and a tapped mark as the nfc method, so the two capture methods stay apart",
    regQf?.checkInMethod === "nfc", `checkInMethod=${regQf?.checkInMethod}`);

  // NULL IS NOT "STAFF" AND NOT "NFC". The default-to-nfc failure is the one this whole
  // change exists to prevent, and it is invisible unless something asserts on a mark that
  // has no method at all — so both of these are the discriminating half.
  check("a mark a member of staff made claims no capture method",
    regQa?.checkInMethod === null && !!regQa?.takenBy,
    `checkInMethod=${regQa?.checkInMethod} takenBy=${regQa?.takenBy}`);
  check("and a student nobody has marked claims none either — no mark, no method",
    regQe?.checkInMethod === null && regQe?.status === null,
    `checkInMethod=${regQe?.checkInMethod} status=${regQe?.status}`);

  // The live view: the same four marks, the same session, a different serialiser. This is
  // the screen that chose an icon from the stamp, so it is the one the old bug was on.
  const methodLive = await call(`/hnd/sessions/${live.id}/live`, { token: adminToken });
  const liveRow = (id) => methodLive.data?.rows?.find((r) => r.student?.id === id);
  check("the live view agrees with the register about all four, method by method",
    methodLive.status === 200
      && liveRow(QC_ID)?.checkInMethod === "qr" && liveRow(QF_ID)?.checkInMethod === "nfc"
      && liveRow(QA_ID)?.checkInMethod === null && liveRow(QE_ID)?.checkInMethod === null,
    `HTTP ${methodLive.status} qc=${liveRow(QC_ID)?.checkInMethod} qf=${liveRow(QF_ID)?.checkInMethod} `
      + `qa=${liveRow(QA_ID)?.checkInMethod} qe=${liveRow(QE_ID)?.checkInMethod}`);

  // And the per-student history, which is the third row shape carrying `selfMarked` and
  // the one nothing was reading the method from yet. Asked per student, so each of the
  // four is its own request; the row for THIS session is the one under test.
  const historyMethod = async (studentId) => {
    const h = await call(`/hnd/sessions/${live.id}/students/${studentId}/history`, { token: adminToken });
    const row = h.data?.rows?.find((r) => r.sessionId === live.id);
    return { http: h.status, found: !!row, method: row?.checkInMethod ?? null, status: row?.status ?? null };
  };
  const [hQc, hQf, hQa, hQe] = await Promise.all([QC_ID, QF_ID, QA_ID, QE_ID].map(historyMethod));
  check("a student's own history names the method for the session they scanned",
    hQc.http === 200 && hQc.found && hQc.method === "qr", `HTTP ${hQc.http} found=${hQc.found} method=${hQc.method}`);
  check("and for the session they tapped",
    hQf.found && hQf.method === "nfc", `found=${hQf.found} method=${hQf.method}`);
  check("a staff-made mark in the history claims no method",
    hQa.found && hQa.method === null && hQa.status === "E", `found=${hQa.found} method=${hQa.method} status=${hQa.status}`);
  // The history lists every session on the module, marked or not, so the unmarked student
  // HAS a row here — a row that exists is the one that can wrongly name a method for a
  // mark that does not, which is why the assertion is on the row rather than its absence.
  check("and an unmarked session in the history claims none either",
    hQe.found && hQe.method === null && hQe.status === null, `found=${hQe.found} method=${hQe.method} status=${hQe.status}`);

  /* ====================================================================== */
  console.log("\n--- switching the feature on and off while people are using it ---");
  /* ====================================================================== */

  // The owner's question: does flipping this switch mid-term break anything. The risk is
  // not the switch itself, it is everything holding a decision made a moment earlier — a
  // code already on a projector, a screen mid-poll, a settings cache. So the cycle is run
  // TWICE, and the important assertion is the third one: a code minted while the feature
  // was on must stop working the instant it is off. If it did not, switching the feature
  // off would leave a window in which the register could still be written to by anybody
  // holding a photograph of the screen.
  const setQr = (on) => call("/tags/settings", { method: "PUT", token: adminToken, body: { qrEnabled: on } });
  const toggleSession = await db.hndSession.create({ data: { unitId: unit.id, date: today, startTime: shift(now, -21), endTime: shift(now, 99), description: "qr toggle" } });
  made.sessions.push(toggleSession.id);
  // QB is seeded onto the term-locked unit, not this one. Without this the last scan below
  // is refused for NOT BEING ENROLLED and the toggle proves nothing — which is exactly how
  // it failed the first time it ran.
  const toggleEnrolment = await db.enrolment.create({ data: { studentId: QB_ID, unitId: unit.id } });
  made.enrolments.push(toggleEnrolment.id);

  for (const cycle of [1, 2]) {
    const onAgain = await setQr(true);
    check(`cycle ${cycle}: an administrator can switch QR check-in on`,
      onAgain.status === 200 && onAgain.data?.qrEnabled === true, `HTTP ${onAgain.status}`);

    const mintOn = await call(`/hnd/sessions/${toggleSession.id}/qr-code`, { token: adminToken });
    check(`cycle ${cycle}: the screen gets a code while it is on`,
      mintOn.status === 200 && typeof mintOn.data?.code === "string", `HTTP ${mintOn.status}`);
    // The code the lecturer is holding at the moment the switch is thrown.
    const codeInHand = mintOn.data?.code;

    const offNow = await setQr(false);
    check(`cycle ${cycle}: and can switch it back off`,
      offNow.status === 200 && offNow.data?.qrEnabled === false, `HTTP ${offNow.status}`);

    const staleScan = await call("/student/me/qr-check-in", { method: "POST", token: qbToken, body: { sessionId: toggleSession.id, code: codeInHand } });
    check(`cycle ${cycle}: a code minted a moment earlier is refused the instant the feature is off`,
      staleScan.status === 403 && staleScan.data?.reason === "qr_off",
      `HTTP ${staleScan.status} reason=${staleScan.data?.reason}`);
    const noMark = await db.attendanceMark.findFirst({ where: { sessionId: toggleSession.id, studentId: QB_ID } });
    check(`cycle ${cycle}: and it wrote nothing`, !noMark, noMark ? `mark ${noMark.id} written` : "");

    const mintOff = await call(`/hnd/sessions/${toggleSession.id}/qr-code`, { token: adminToken });
    check(`cycle ${cycle}: the screen is told the feature is off rather than being handed a dead code`,
      mintOff.status === 409 && mintOff.data?.reason === "qr_disabled", `HTTP ${mintOff.status}`);

    // Both capture methods are now off, which is the one state the screens warn about.
    const liveOff = await call(`/hnd/sessions/${toggleSession.id}/live`, { token: adminToken });
    check(`cycle ${cycle}: the live view reports both methods off and stops claiming to accept`,
      liveOff.data?.qrEnabled === false && liveOff.data?.tapEnabled === false && liveOff.data?.acceptingTaps === false,
      `qr=${liveOff.data?.qrEnabled} tap=${liveOff.data?.tapEnabled} accepting=${liveOff.data?.acceptingTaps}`);

    // The regression that made a QR-only college's students see an empty day. With BOTH
    // switches off the timetable must still be answered — it is a fact about the day, not
    // about check-in — or the student screen says "that's you done for today" mid-lecture.
    const ctxOff = await call("/student/me/tap-context", { token: qbToken });
    check(`cycle ${cycle}: a student still gets their timetable with every method switched off`,
      ctxOff.status === 200 && ctxOff.data?.qrEnabled === false && (ctxOff.data?.today || []).length > 0,
      `HTTP ${ctxOff.status} today=${(ctxOff.data?.today || []).length}`);
  }

  // Left ON, and a FRESH code still marks somebody — the feature is not one-shot, and two
  // full cycles have not left anything latched.
  await setQr(true);
  const afterCycles = await call("/student/me/qr-check-in", { method: "POST", token: qbToken, body: { sessionId: toggleSession.id, code: codeFor(toggleSession.id) } });
  const cycledMark = await db.attendanceMark.findFirst({ where: { sessionId: toggleSession.id, studentId: QB_ID } });
  if (cycledMark) made.marks.push(cycledMark.id);
  // L, not P, and that is the point: this session started 21 minutes ago against a 15
  // minute threshold, so asserting Late proves the mark is still being decided from the
  // clock after all that toggling, rather than merely proving a row appeared.
  check("after two on/off cycles a fresh code still marks the student, still by the clock",
    afterCycles.status === 201 && afterCycles.data?.status === "L" && cycledMark?.status === "L",
    `HTTP ${afterCycles.status} status=${afterCycles.data?.status} reason=${afterCycles.data?.reason || "none"}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
} catch (e) {
  console.error("suite error:", e);
  process.exitCode = 1;
} finally {
  await cleanup();
  await db.$disconnect();
}
