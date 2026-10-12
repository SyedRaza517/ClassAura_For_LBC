// Attendance capture when two writers are genuinely at the same instant.
//
// Every other attendance suite here proves BEHAVIOUR: given a request, what is written
// and what is refused. This one proves something orthogonal and much harder to see in a
// code review — that the guards which settle a COLLISION are structural (a unique
// constraint, a WHERE clause, a lock) rather than an `if` that happens to run first, and
// that they still hold when two writers overlap rather than merely arrive close together.
//
// A sequential test of a race proves nothing at all. Two requests that never overlap
// cannot collide, so the assertion passes identically with the guard deleted — which is
// precisely the false negative testing.md warns about ("Twice in recent work a test
// passed while discriminating nothing"). So every block below either fires its calls with
// `Promise.all`, never awaited one after another, or PLANTS the exact mid-write state a
// crash would leave; and every block asserts what the DATABASE holds afterwards, because
// two calls can both answer 200 while two rows exist underneath them — or while one of
// them has silently overwritten the other's mark.
//
// ====================================================================================
// WHAT THE THREE CAPTURE PATHS ACTUALLY DO ABOUT COLLISIONS (read before editing)
// ====================================================================================
//
//   STAFF PRESENCE, POST /api/checkins/check-in — `create` inside a `try`, with a `catch`
//   that absorbs P2002 on @@unique([staffId,date]), re-reads the winner and answers 200
//   (NOT 201) with that row. The route's own comment is the best description of the race
//   in this codebase and the choice of 200 is deliberate: "201 would claim it created
//   something" when it did not. That comment is the standard every block below is held to.
//
//   QR CHECK-IN, POST /api/student/me/qr-check-in — the same shape on
//   @@unique([sessionId,studentId]): an existence check, then `create` in a `try` whose
//   catch re-reads the standing mark and answers 200 `alreadyMarked`. The existence check
//   is the fast path, not the guard; the constraint is the guard.
//
//   TEAMS SYNC, teamsSync.js — `createMany({ skipDuplicates: true })` on the same
//   constraint, which IS the never-overwrite invariant: a mark that already stands is a
//   row at that key, so the insert for it is skipped rather than colliding. Plus an
//   in-process `running` boolean as a run guard (conventions.md: every lock here is
//   in-process, correct for one Node process and nothing more).
//
// So all three paths end at ONE unique constraint and the writer that gets there first
// wins. The precedence rule across the whole feature is therefore "first writer wins,
// whichever path it came from, and the loser reports what stands" — and the blocks below
// pin that in both orders, because a precedence that depends on arrival order is only
// defensible if the LOSER is told the truth about it.
//
// ====================================================================================
// HOW A QR SCAN AND A TEAMS INGESTION CAN COLLIDE AT ALL, WHICH IS NOT OBVIOUS
// ====================================================================================
//
// The two paths look temporally disjoint, and almost are. The Teams collector skips any
// session that has not ended (`session.date === today && session.endTime >= nowTime`),
// and QR check-in is refused outside the session's own window — so for an ordinary class
// the two can never be in flight against the same register.
//
// `checkInOpenUntil` is the seam that makes them overlap, and it is an ordinary thing for
// a lecturer to use: it "holds check-in open PAST the end for late arrivals" (schema.prisma),
// and withinSessionWindow takes `Math.max(end, held)` as the close. The COLLECTOR does not
// consult it — it reads `endTime` alone. So a class that ended at 10:00 and was held open
// until 11:00 is, between those two times, simultaneously:
//
//     * collectable by the Teams sync (it ended), and
//     * open to QR scans (it is held open).
//
// That window is this suite's cross-path scenario, and it is real rather than contrived:
// every session in block D is built exactly that way. Nothing below depends on a clock
// trick, a patched module or a fake timer.
//
// ====================================================================================
// THIS SUITE'S OWN API PROCESS
// ====================================================================================
//
// Spawned here, on its own port, for the same reason smoke-teams-attendance.mjs spawns
// one: TEAMS_GRAPH_FIXTURES has to be in the environment the API was STARTED with, and
// `npm test`'s shared instance on 4010 never sees it. The JWT_SECRET is INHERITED rather
// than invented, because the QR signing key derives from the session secret (secrets.js)
// and this suite mints codes locally — suite and server must derive the same key or every
// happy-path scan fails for a reason that looks nothing like its cause.
//
// It also buys something this suite specifically needs: a FRESH in-process rate-limit Map.
// The ten-attempts-a-minute student budget lives in routes/student.js at module level and
// is shared across suites on the shared API; a burst of eight concurrent scans would be
// at the mercy of whatever smoke-nfc-tap had already spent. Here nobody has spent anything.
//
//   node scripts/smoke-attendance-concurrency.mjs
//   (needs DATABASE_URL and JWT_SECRET; `npm test` supplies both)
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { collegeWideReader } from "./lib/college-wide-reader.mjs";
import { fixtureDepartmentFor, stamp } from "./lib/fixture-department.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const server = join(root, "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

// Exit 2 = SKIP, the runner's convention, and deliberately NOT a pass: a suite that could
// not run must stay visible as a gap rather than count as coverage.
if (!process.env.DATABASE_URL) {
  console.log("SKIP — DATABASE_URL is not set, so there is no database to run this suite against");
  process.exit(2);
}
if (!process.env.JWT_SECRET) {
  console.log("SKIP — JWT_SECRET is not set, so no QR code can be derived that this suite's own API would accept");
  process.exit(2);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const bcrypt = require(join(server, "node_modules", "bcryptjs"));
const { deriveCode, windowIndexFor, graceFor, CODE_LENGTH } = require(join(server, "src", "attendanceQr.js"));
const { qrSigningKey } = require(join(server, "src", "secrets.js"));
const { SELF_CHECKIN_QR_STAMP, TEAMS_AUTO_STAMP } = require(join(server, "src", "attendanceTap.js"));
// READ, never repeated: a rotation period that disagrees with the server's produces a
// different window index, and every scan below then fails for a reason that looks like a
// signature problem. The literal 30 in an earlier suite went stale exactly this way.
const { DEFAULTS: TAP_DEFAULTS } = require(join(server, "src", "attendanceTapSettings.js"));

const RUN = Date.now().toString(36);
const PORT = Number(process.env.ATTENDANCE_CONCURRENCY_SMOKE_PORT || 4029);
const API = `http://127.0.0.1:${PORT}/api`;
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;
const SEED_PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
const JWT_SECRET = process.env.JWT_SECRET;
// Its own key, like the Teams suite's: this process is this suite's, and a run of it must
// neither depend on nor leak into whatever the outer runner configured.
const CREDENTIALS_KEY = randomBytes(32).toString("base64");
const FIXTURES_PATH = join(tmpdir(), `attendance-concurrency-fixtures-${RUN}.json`);

const ZONE = process.env.APP_TIMEZONE || "Europe/London";
const todayLocal = () => new Date().toLocaleDateString("en-CA", { timeZone: ZONE });
const dayOffset = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString("en-CA", { timeZone: ZONE });
const nowHHMM = () => new Date().toLocaleTimeString("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit" });
// Clamped to the day, exactly as smoke-qr-checkin.mjs clamps it. The clamp is what keeps
// this suite runnable at any hour: a run at 00:20 asks for "ninety minutes ago", gets
// 00:00, and every predicate below still reads the way the block intends (the session has
// ended, it is held open, the scan is late) rather than wrapping into yesterday.
const shift = (hhmm, mins) => {
  const [h, m] = hhmm.split(":").map(Number);
  const t = Math.max(0, Math.min(23 * 60 + 59, h * 60 + m + mins));
  return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
};

const SECRET = qrSigningKey();
const ROTATE = TAP_DEFAULTS.qrRotateSeconds;
const GRACE = graceFor(ROTATE);
const codeFor = (sessionId, offsetWindows = 0) =>
  deriveCode({ secret: SECRET, sessionId, windowIndex: windowIndexFor(Math.floor(Date.now() / 1000), ROTATE) + offsetWindows });

// A code derived in the last moments of a window is a DIFFERENT window by the time the
// API reads its own clock. Every block that asserts something about window arithmetic
// waits out the tail first, or it tests whatever the clock happened to be doing.
const avoidBoundary = async () => {
  const into = Math.floor(Date.now() / 1000) % ROTATE;
  if (into >= ROTATE - 3) await new Promise((r) => setTimeout(r, (ROTATE - into + 1) * 1000));
};
// The opposite: stand JUST PAST a rotation, the only moment at which the code that has
// just left the screen can be observed still verifying (it does so for graceFor(ROTATE)
// seconds and no longer — attendanceQr.js).
const justAfterBoundary = async () => {
  const into = Math.floor(Date.now() / 1000) % ROTATE;
  if (into !== 0) await new Promise((r) => setTimeout(r, (ROTATE - into) * 1000 + 250));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
// A line that is NOT an assertion: an observation this suite reports but refuses to
// assert, because the honest answer is "it depends on which way the race fell this time".
// Printed so a reader sees what happened; never counted as coverage.
const note = (text) => console.log(`· ${text}`);

async function call(path, { method = "GET", body, token, headers: extra } = {}) {
  const headers = { "Content-Type": "application/json", ...(extra || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}
const login = (email, password) => call("/auth/login", { method: "POST", body: { email, password } });

const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const TODAY = todayLocal();
const YEST = dayOffset(-1);
const S_PASSWORD = `conc-suite-${RUN}`;
const S_HASH = bcrypt.hashSync(S_PASSWORD, 10);
const ORG_ID = "org-conc";
const ORG_EMAIL = `organizer-conc-${RUN}@x.ac.uk`;
const joinUrl = (n) => `https://teams.microsoft.com/l/meetup-join/19%3ameeting_conc_${RUN}_${n}%40thread.v2/0`;

const made = { sessions: [], students: [], enrolments: [], staff: [], units: [] };
let course = null, cohort = null;
let child = null, bootLog = "";
let integrationExisted = false, priorIntegration = null;
let teamsConfigExisted = false, priorTeamsConfig = null;
let tapConfigExisted = false, priorTapConfig = null;
let runStart = null;
let disposeRunner = async () => {};

// The Graph fixture file, rewritten in place as the suite goes. teamsGraph.js reads it
// FRESH on every call (no cache), which is what lets one API process play several
// scenarios — so a session created half way through this suite can have its attendance
// report added at the same moment rather than needing a second process.
const fixtures = {
  organizers: [{ email: ORG_EMAIL, id: ORG_ID }],
  // EMPTY CALENDAR, deliberately. Discovery is covered at length by
  // smoke-teams-attendance.mjs; this suite pre-sets teamsJoinUrl and teamsMeetingId on
  // every session it wants collected, so the only phase running here is COLLECTION — the
  // one that writes marks, which is the only one that can collide with a scan.
  calendars: { [ORG_ID]: [] },
  meetingIds: {},
  attendanceByOccurrence: {},
};
const writeFixtures = () => writeFileSync(FIXTURES_PATH, JSON.stringify(fixtures, null, 2));

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
    await sleep(400);
  }
  return false;
}

async function cleanup() {
  try {
    await disposeRunner().catch(() => {});
    // TagTap has NO foreign key (schema.prisma says why: a refused tap must stay
    // writable when nothing was identified), so nothing cascades it and it has to be
    // deleted by hand — by session AND by student, because the refusals in this suite
    // include ones logged against no session at all.
    if (made.sessions.length) await db.tagTap.deleteMany({ where: { sessionId: { in: made.sessions } } }).catch(() => {});
    if (made.students.length) await db.tagTap.deleteMany({ where: { studentId: { in: made.students } } }).catch(() => {});
    if (made.staff.length) await db.tagTap.deleteMany({ where: { staffId: { in: made.staff } } }).catch(() => {});
    // AttendanceMark cascades from HndSession, so deleting the sessions takes every mark
    // this suite caused with them — including the hundreds the ballast runs wrote, which
    // is why they are not tracked individually.
    if (made.sessions.length) await db.hndSession.deleteMany({ where: { id: { in: made.sessions } } }).catch(() => {});
    if (made.staff.length) await db.checkIn.deleteMany({ where: { staffId: { in: made.staff } } }).catch(() => {});
    for (const id of made.enrolments) await db.enrolment.delete({ where: { id } }).catch(() => {});
    if (made.students.length) await db.student.deleteMany({ where: { id: { in: made.students } } }).catch(() => {});
    if (made.staff.length) await db.staff.deleteMany({ where: { id: { in: made.staff } } }).catch(() => {});
    // After the sessions and the enrolments, both of which point at them.
    if (made.units.length) await db.unit.deleteMany({ where: { id: { in: made.units } } }).catch(() => {});
    if (cohort) await db.cohort.delete({ where: { id: cohort.id } }).catch(() => {});
    if (course) await db.course.delete({ where: { id: course.id } }).catch(() => {});

    // This suite's own run rows only, scoped by startedAt rather than a bare
    // deleteMany({}) — the same courtesy smoke-teams-attendance.mjs pays, and for the
    // same reason: a bare delete would take down anything else that ever writes one.
    if (runStart) await db.teamsSync.deleteMany({ where: { startedAt: { gte: runStart } } }).catch(() => {});

    // Three pieces of institution state are put back EXACTLY as found. A college left
    // with Teams attendance switched on, or with a lateness threshold this suite's
    // concurrent-settings burst happened to land on, is the one thing in here that would
    // change the real product rather than only this database.
    if (tapConfigExisted) {
      await db.attendanceTapConfig.upsert({
        where: { id: "singleton" }, update: { settings: priorTapConfig }, create: { id: "singleton", settings: priorTapConfig },
      }).catch(() => {});
    } else {
      await db.attendanceTapConfig.deleteMany({}).catch(() => {});
    }
    if (teamsConfigExisted) {
      await db.teamsAttendanceConfig.upsert({
        where: { id: "singleton" }, update: { settings: priorTeamsConfig }, create: { id: "singleton", settings: priorTeamsConfig },
      }).catch(() => {});
    } else {
      await db.teamsAttendanceConfig.deleteMany({}).catch(() => {});
    }
    if (integrationExisted) {
      const { id, ...rest } = priorIntegration;
      await db.tenantIntegration.update({ where: { id }, data: rest }).catch(() => {});
    } else {
      await db.tenantIntegration.deleteMany({ where: { provider: "teams" } }).catch(() => {});
    }
  } catch (e) {
    console.error("cleanup problem:", e.message);
  }
  try { unlinkSync(FIXTURES_PATH); } catch { /* never written, or already gone */ }
}

try {
  writeFixtures();

  // Remember the three config rows BEFORE anything is changed, and switch the Teams
  // feature OFF in the database first.
  //
  // THE SWITCH-OFF IS NOT TIDINESS. index.js starts scheduler.js, which runs its whole
  // tick ONCE ON BOOT — including maybeSyncTeamsAttendance. If a previous (or abandoned)
  // run of this suite left TeamsAttendanceConfig.enabled true and the credentials saved,
  // the API would start a SCHEDULED sync while this suite was still seeding, and every
  // "a sync is already running" assertion below would be racing a third party nobody
  // asked for. Off at boot, on over HTTP afterwards, is the only ordering that makes the
  // run guard's behaviour attributable to this suite.
  const priorTapRow = await db.attendanceTapConfig.findFirst({});
  tapConfigExisted = Boolean(priorTapRow);
  priorTapConfig = priorTapRow?.settings ?? {};
  const priorTeamsRow = await db.teamsAttendanceConfig.findFirst({});
  teamsConfigExisted = Boolean(priorTeamsRow);
  priorTeamsConfig = priorTeamsRow?.settings ?? {};
  const priorIntegrationRow = await db.tenantIntegration.findFirst({ where: { provider: "teams" } });
  integrationExisted = Boolean(priorIntegrationRow);
  priorIntegration = priorIntegrationRow;
  await db.teamsAttendanceConfig.upsert({
    where: { id: "singleton" }, update: { settings: { ...(priorTeamsConfig || {}), enabled: false } },
    create: { id: "singleton", settings: { enabled: false } },
  });

  console.log(`→ starting a private API on port ${PORT} (TEAMS_GRAPH_FIXTURES=${FIXTURES_PATH})`);
  child = spawn("node", ["src/index.js"], {
    cwd: server,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "test",
      JWT_SECRET,
      CREDENTIALS_KEY,
      TEAMS_GRAPH_FIXTURES: FIXTURES_PATH,
      // EVERY cache off. A concurrency suite that reads settings through a 30-second
      // cache is asserting about a snapshot, not about the row — and block G writes that
      // row from six requests at once.
      ATTENDANCE_TAP_CACHE_MS: "0",
      TEAMS_ATTENDANCE_CACHE_MS: "0",
      INTEGRATION_CACHE_MS: "0",
    },
  });
  child.stdout.on("data", (d) => { bootLog += d; });
  child.stderr.on("data", (d) => { bootLog += d; });
  let diedEarly = false;
  child.on("exit", (code) => { if (code) diedEarly = true; });

  if (!await waitForApi()) {
    console.log(`SKIP — this suite's own API on port ${PORT} never became healthy` +
      (diedEarly ? " (it exited)" : " (timed out)") + `. Last output:\n${bootLog.slice(-2000)}`);
    stopApi();
    await cleanup();
    await db.$disconnect();
    process.exit(2);
  }
  console.log("  private API healthy\n");

  const adminLogin = await login("admin@edtech.co.uk", SEED_PASSWORD);
  const adminToken = adminLogin.data?.token;
  if (!adminToken) throw new Error(`admin sign-in failed (HTTP ${adminLogin.status}) — cannot run this suite`);
  // A Teams sync is a whole-college job (requireCollegeWide): on the ordinary pass this
  // is the admin's own token and nothing is created; under SMOKE_SCOPED_DEPARTMENT=1 it
  // is a throwaway college-wide account, so these blocks keep testing the RUN rather
  // than the departmental refusal. See lib/college-wide-reader.mjs.
  const runner = await collegeWideReader({ call, token: adminToken, label: "tconc" });
  const runToken = runner.token;
  disposeRunner = runner.dispose;
  // And the department those fixtures must carry so the same assertions hold on both
  // sides of the academic-scope guard. Null on the ordinary pass.
  const DEPT = await fixtureDepartmentFor(db, "admin@edtech.co.uk");

  // ====================================================================================
  // Fixtures: one course, one cohort, nine students, and ONE UNIT PER SESSION.
  //
  // NO cohortId on any session, which is a deliberate simplification rather than an
  // oversight: rosterForSession returns the unit's enrolments outright when a session
  // carries no cohort (registers.js), so a unit with one enrolment gives that session a
  // roster of exactly one student, with no TimetableEvent and no group rows to keep in
  // step. The roster rule itself is covered by smoke-timetable-registers.mjs; what this
  // suite needs from it is only that it is stable and small, because a Teams run writes a
  // mark for every rostered student and this suite starts eleven of them.
  //
  // A UNIT PER SESSION rather than one shared unit, and the reason is a constraint rather
  // than taste: HndSession is unique on (unitId, date, startTime, cohortId) through two
  // partial indexes that Prisma cannot see (schema.prisma says so at length). Several
  // blocks here need a session that started "a few minutes ago" on the same day, and
  // shift() clamps to the day — so at 00:03 two of those requests resolve to the same
  // 00:00 start and the second create dies on a constraint Prisma does not even know to
  // report nicely. Separate units make the key distinct however the clock falls, which is
  // what keeps this suite runnable at every hour rather than only in the afternoon.
  //
  // NINE STUDENTS, ONE PER BLOCK, and that is the rate limiter's doing. The student
  // budget is ten check-in attempts a minute shared across all capture methods
  // (routes/student.js), and a burst of eight concurrent scans spends eight of them in
  // one instant — so a block that borrowed another block's student would be asserting
  // about a 429 it caused itself.
  // ====================================================================================
  course = await db.course.create({ data: { ...stamp(DEPT), name: `Concurrency Suite Course ${RUN}` } });
  cohort = await db.cohort.create({ data: { ...stamp(DEPT), courseId: course.id, name: `Concurrency Suite Intake ${RUN}` } });

  const mkStudent = async (label, n) => {
    const s = await db.student.create({ data: {
      firstName: `Conc${n}`, lastName: `Suite${RUN}`, studentRef: `CNC${RUN}${n}`.slice(0, 20),
      email: `conc-${label}-${RUN}@x.ac.uk`, initials: `C${n}`, colour: "#1a73e8",
      cohortId: cohort.id, passwordHash: S_HASH, tokenVersion: 0,
    } });
    made.students.push(s.id);
    const tok = (await login(s.email, S_PASSWORD)).data?.token;
    if (!tok) throw new Error(`student ${label} sign-in failed — cannot run this suite`);
    return { ...s, token: tok };
  };

  // One unit, carrying one enrolment per student that belongs on its register. No termId:
  // termOpenOn(undefined, date) is never locked, so the term gate cannot become an
  // accidental variable in a suite about collisions.
  let unitSeq = 0;
  const mkUnit = async (label, students) => {
    unitSeq += 1;
    const u = await db.unit.create({ data: {
      ...stamp(DEPT), code: `CN${RUN}${unitSeq}`.slice(0, 12), name: `Concurrency ${label} ${RUN}`,
      courseId: course.id, startDate: YEST, endDate: TODAY,
    } });
    made.units.push(u.id);
    for (const s of students) {
      const e = await db.enrolment.create({ data: { studentId: s.id, unitId: u.id } });
      made.enrolments.push(e.id);
    }
    return u;
  };
  const stuA2 = await mkStudent("a2", 1);
  const stuA8 = await mkStudent("a8", 2);
  const stuB1 = await mkStudent("b1", 3);
  const stuB2 = await mkStudent("b2", 4);
  const stuAbort = await mkStudent("abort", 5);
  const stuCrash = await mkStudent("crash", 6);
  const stuD1 = await mkStudent("d1", 7);
  const stuD2 = await mkStudent("d2", 8);
  const stuD3 = await mkStudent("d3", 9);

  // A session that is running RIGHT NOW: started five minutes ago, ends in two hours.
  // Its own unit, carrying only the student whose block it is.
  const mkLiveSession = async (description, student) => {
    const u = await mkUnit(description, [student]);
    const now = nowHHMM();
    const s = await db.hndSession.create({ data: {
      unitId: u.id, date: TODAY, startTime: shift(now, -5), endTime: shift(now, 115), description,
    } });
    made.sessions.push(s.id);
    return s;
  };

  // A session in the cross-path overlap window: ENDED (so the Teams collector will take
  // it) and HELD OPEN (so a QR scan is still in-window). See the header for why this is
  // the only shape in which the two paths can reach the same row.
  const mkOverlapSession = async (description, meetingId, students) => {
    const presentStudentEmails = students.map((s) => s.email);
    const u = await mkUnit(description, students);
    const now = nowHHMM();
    const startTime = shift(now, -90);
    const endTime = shift(now, -30);
    const url = joinUrl(meetingId);
    const s = await db.hndSession.create({ data: {
      unitId: u.id, date: TODAY, startTime, endTime, description,
      teamsJoinUrl: url, teamsMeetingId: meetingId, teamsOrganizerId: ORG_ID,
      checkInOpenUntil: shift(now, 60),
    } });
    made.sessions.push(s.id);
    fixtures.meetingIds[url] = meetingId;
    fixtures.attendanceByOccurrence[meetingId] = [{
      date: TODAY,
      // Joined at the start and stayed to the end: full attendance, so decideStatus
      // answers P with firstJoin === startTime. The QR path would write L for the same
      // scan (statusFor compares the scan's minute against start + lateAfterMins, and
      // this class started ninety minutes ago) — so `status` ALONE could tell the two
      // writers apart. `takenBy` is what the assertions actually use, because it is
      // distinct at every hour of the day, including a 00:0x run where the clamp above
      // leaves the scan inside the lateness grace and both paths would say P.
      intervals: presentStudentEmails.map((email) => ({ email, msUserId: null, intervals: [{ joinedAt: startTime, leftAt: endTime }] })),
    }];
    writeFixtures();
    return s;
  };

  // BALLAST: yesterday's ended classes, each with its own meeting and report, created
  // purely to make a sync run take long enough that a concurrent request demonstrably
  // lands INSIDE it. Yesterday rather than today because the collector's "not ended yet"
  // skip only applies to today — so these are eligible whatever time of day this suite
  // runs, including a run at 00:05 where today has no past slots at all.
  const mkBallast = async (tag, count) => {
    const u = await mkUnit(`ballast ${tag}`, [stuA2]);
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const meetingId = `m-${tag}-${i}-${RUN}`;
      const url = joinUrl(meetingId);
      // Fixed, distinct start times on one unit — nothing here depends on the clock, so
      // the (unitId, date, startTime) key is satisfied by the index rather than by shift().
      const startTime = `08:${String(i * 2).padStart(2, "0")}`;
      const s = await db.hndSession.create({ data: {
        unitId: u.id, date: YEST, startTime, endTime: "09:30",
        description: `Concurrency ballast ${tag} ${i}`,
        teamsJoinUrl: url, teamsMeetingId: meetingId, teamsOrganizerId: ORG_ID,
      } });
      made.sessions.push(s.id);
      out.push(s);
      fixtures.meetingIds[url] = meetingId;
      fixtures.attendanceByOccurrence[meetingId] = [{
        date: YEST, intervals: [{ email: stuA2.email, msUserId: null, intervals: [{ joinedAt: startTime, leftAt: "09:30" }] }],
      }];
    }
    writeFixtures();
    return out;
  };

  const markFor = (sessionId, studentId) =>
    db.attendanceMark.findUnique({ where: { sessionId_studentId: { sessionId, studentId } } });
  const marksFor = (sessionId, studentId) =>
    db.attendanceMark.count({ where: { sessionId, studentId } });
  const qrScan = (student, session, offsetWindows = 0) => call("/student/me/qr-check-in", {
    method: "POST", token: student.token,
    body: { sessionId: session.id, code: codeFor(session.id, offsetWindows) },
  });

  /* ====================================================================== */
  console.log("\n--- the settings this suite runs under ---");
  /* ====================================================================== */

  // Set explicitly rather than inherited. NFC stickers stay OFF, so nothing below can be
  // explained by the other capture path; the place checks stay off, so no assertion is
  // at the mercy of where the test machine thinks it is.
  const tapOn = await call("/tags/settings", {
    method: "PUT", token: adminToken,
    body: {
      qrEnabled: true, qrRotateSeconds: ROTATE, enabled: false, declareEnabled: false,
      lateAfterMins: 15, earlyGraceMins: 0,
      networkCheck: false, geofenceCheck: false, staffTapEnabled: false,
      staffNetworkCheck: false, staffGeofenceCheck: false,
    },
  });
  check("QR check-in is on, stickers and place checks off",
    tapOn.status === 200 && tapOn.data?.qrEnabled === true && tapOn.data?.enabled === false && tapOn.data?.qrRotateSeconds === ROTATE,
    `HTTP ${tapOn.status} qrEnabled=${tapOn.data?.qrEnabled} rotate=${tapOn.data?.qrRotateSeconds}`);

  /* ====================================================================== */
  console.log("\n--- A. one scan, several POSTs: the double-tap race ---");
  /* ====================================================================== */
  // THE RACE: every one of these requests reads `findUnique` and finds no mark, because
  // they are all inside the same read-then-write window. They then all call `create`
  // against @@unique([sessionId,studentId]). One wins; the database refuses the rest with
  // P2002, and what the route does with that refusal is the whole question.
  //
  // THE ASSERTIONS ARE THE ONES routes/checkins.js ARGUED FOR at length for its own
  // clock-in button: exactly ONE 201 (only the writer may claim to have created
  // something), every loser 200 WITH THE STANDING RECORD (they are checked in, which is
  // the one fact they pressed the button to establish), no 500 anywhere, and exactly one
  // row underneath. A 500 here is the shape of the original defect: "a stress test firing
  // two presses with Promise.all found it on its first run".
  //
  // Two first, then eight, because the two differ in kind: two presses is a double-tap and
  // eight is an app retry loop on a congested network, and a guard that happens to hold
  // for one collision can still be overwhelmed by seven.
  await avoidBoundary();
  const burst2Session = await mkLiveSession("concurrency burst of two", stuA2);
  const burst2 = await Promise.all([qrScan(stuA2, burst2Session), qrScan(stuA2, burst2Session)]);
  const created2 = burst2.filter((r) => r.status === 201);
  const standing2 = burst2.filter((r) => r.status === 200 && r.data?.alreadyMarked === true);
  check("two simultaneous scans: exactly one answers 201",
    created2.length === 1, `statuses ${burst2.map((r) => r.status).join(", ")}`);
  check("...and the loser gets 200 with the mark that stands, never 201 and never a 500",
    standing2.length === 1, `statuses ${burst2.map((r) => r.status).join(", ")} bodies ${JSON.stringify(burst2.map((r) => r.data?.reason || r.data?.alreadyMarked))}`);
  check("...and the register holds exactly one mark",
    await marksFor(burst2Session.id, stuA2.id) === 1, `${await marksFor(burst2Session.id, stuA2.id)} mark(s)`);
  const burst2Mark = await markFor(burst2Session.id, stuA2.id);
  check("...whose status both answers agree with — the loser was told the truth, not a guess",
    burst2.every((r) => (r.data?.status || null) === burst2Mark?.status),
    `db=${burst2Mark?.status} answers=[${burst2.map((r) => r.data?.status).join(", ")}]`);
  check("...and it is a QR self check-in, stamped as one",
    burst2Mark?.takenBy === SELF_CHECKIN_QR_STAMP, `takenBy=${burst2Mark?.takenBy}`);
  const burst2Taps = await db.tagTap.findMany({ where: { sessionId: burst2Session.id, studentId: stuA2.id, method: "qr" } });
  check("...and the tap log records one 'marked' and one idempotent repeat, not two marks",
    burst2Taps.filter((t) => t.outcome === "marked").length === 1 && burst2Taps.filter((t) => t.outcome === "already_marked").length === 1,
    burst2Taps.map((t) => t.outcome).join(", "));

  await avoidBoundary();
  const burst8Session = await mkLiveSession("concurrency burst of eight", stuA8);
  // EIGHT, not eighty. The budget is ten a minute and this is a proof that a race exists,
  // not a load test: tens of requests, never thousands (and the two refunded losers of
  // block A's first burst are why eight rather than ten is the ceiling that stays honest).
  const BURST = 8;
  const burst8 = await Promise.all(Array.from({ length: BURST }, () => qrScan(stuA8, burst8Session)));
  const codes8 = burst8.map((r) => r.status);
  check(`a burst of ${BURST} simultaneous scans: exactly one 201`,
    codes8.filter((s) => s === 201).length === 1, `statuses ${codes8.join(", ")}`);
  check("...the other seven all 200 with the standing mark",
    burst8.filter((r) => r.status === 200 && r.data?.alreadyMarked === true).length === BURST - 1, `statuses ${codes8.join(", ")}`);
  check("...NO unhandled P2002 reached the client as a 500",
    codes8.every((s) => s < 500), `statuses ${codes8.join(", ")}`);
  check("...and NOBODY was rate-limited, so all eight really did collide",
    codes8.every((s) => s !== 429), `statuses ${codes8.join(", ")}`);
  check("...and the register holds exactly one mark",
    await marksFor(burst8Session.id, stuA8.id) === 1, `${await marksFor(burst8Session.id, stuA8.id)} mark(s)`);
  const burst8Mark = await markFor(burst8Session.id, stuA8.id);
  check("...with ONE arrival minute, not the last writer's",
    typeof burst8Mark?.checkedInAt === "string" && burst8Mark.checkedInAt.length >= 5, `checkedInAt=${burst8Mark?.checkedInAt}`);
  check("...and every one of the eight answers agrees with the row",
    burst8.every((r) => (r.data?.status || null) === burst8Mark?.status),
    `db=${burst8Mark?.status} answers=[${burst8.map((r) => r.data?.status).join(", ")}]`);

  /* ====================================================================== */
  console.log("\n--- B. the rotation boundary, with two windows in flight ---");
  /* ====================================================================== */
  // The code rotates every ROTATE seconds and the one that just left the screen keeps
  // verifying for graceFor(ROTATE) seconds (attendanceQr.js). So for those few seconds
  // TWO different codes are both valid for the same register — which is exactly the
  // instant a student's phone resubmits the scan it took a moment ago while they also
  // press the button again. Both are honest codes, both must mark, and between them they
  // must still produce ONE mark.
  await justAfterBoundary();
  const boundSession = await mkLiveSession("concurrency rotation boundary", stuB1);
  const boundary = await Promise.all([qrScan(stuB1, boundSession, 0), qrScan(stuB1, boundSession, -1)]);
  check(`both the current code and the one that rotated off ${GRACE}s ago are accepted`,
    boundary.every((r) => r.status === 201 || (r.status === 200 && r.data?.alreadyMarked === true)),
    `statuses ${boundary.map((r) => r.status).join(", ")} reasons ${boundary.map((r) => r.data?.reason || "-").join(", ")}`);
  check("...exactly one of them created the mark",
    boundary.filter((r) => r.status === 201).length === 1, `statuses ${boundary.map((r) => r.status).join(", ")}`);
  check("...and the register holds one mark, not one per window",
    await marksFor(boundSession.id, stuB1.id) === 1, `${await marksFor(boundSession.id, stuB1.id)} mark(s)`);

  // THE OTHER SIDE OF THE BOUNDARY, and the one that must NOT be tolerated: a code from
  // a window that has not happened yet. There is deliberately no forward tolerance —
  // "a code that verifies before it is displayed is a replay window with extra steps" —
  // and concurrency must not become the back door to it. avoidBoundary first, or a
  // rotation between deriving and verifying would turn the +1 code into the current one
  // and this assertion would be testing the clock.
  await avoidBoundary();
  const futureSession = await mkLiveSession("concurrency future window", stuB2);
  const fwd = await Promise.all([qrScan(stuB2, futureSession, 0), qrScan(stuB2, futureSession, +1)]);
  check("a code from the NEXT window is refused even while a valid one is in flight",
    fwd.filter((r) => r.status === 404 && r.data?.reason === "qr_bad_code").length === 1,
    `statuses ${fwd.map((r) => r.status).join(", ")} reasons ${fwd.map((r) => r.data?.reason || "-").join(", ")}`);
  check("...the valid one still marked",
    fwd.filter((r) => r.status === 201).length === 1, `statuses ${fwd.map((r) => r.status).join(", ")}`);
  check("...and exactly one mark exists",
    await marksFor(futureSession.id, stuB2.id) === 1, `${await marksFor(futureSession.id, stuB2.id)} mark(s)`);

  /* ====================================================================== */
  console.log("\n--- C1. a request the client abandons half way through ---");
  /* ====================================================================== */
  // WHAT THIS DOES AND DOES NOT PROVE, because the distinction is the finding.
  //
  // A client-side abort closes the socket. It does NOT cancel the Express handler, and
  // nothing in the QR route is wrapped in `prisma.$transaction` — the mark, the tap-log
  // row, the prediction flag and the audit record are four independent writes. So the
  // honest expectation is NOT "the write is rolled back"; it is "the write completes
  // anyway, and the student is marked even though their phone never heard the answer".
  // For attendance that is the right behaviour — a scan that reached the server IS
  // evidence the student was in the room, and discarding it because the lift doors closed
  // would lose a real mark — but it is only right if the SEQUENCE completes, which is
  // what the assertions check: the mark and its log row are both there, there is exactly
  // one of each, and a retry from the same phone is idempotent rather than a second mark.
  //
  // TIMING THIS RELIABLY IS THE WHOLE DIFFICULTY, and a fixed delay does not do it. The
  // window to abort in is bounded at both ends: too early and undici has not dispatched
  // the request at all, so the server never sees it and there is nothing to assert about;
  // too late and the answer has already arrived, so nothing was abandoned. On this
  // machine the whole round trip is in the low tens of milliseconds and a flat 20ms lost
  // the race on the first run — the assertion failed for a reason that had nothing to do
  // with the product, which is exactly the flake a permanent suite cannot carry.
  //
  // So the delay is SEARCHED rather than guessed, and the search is self-checking: an
  // attempt counts only when BOTH conditions hold — the client saw an AbortError, and the
  // server nevertheless wrote the mark. Each attempt gets its own session (a retry against
  // a session already marked would answer from the idempotent path and prove nothing), the
  // ladder is six attempts at most, and if none of them achieves the state the check fails
  // loudly rather than quietly asserting about whatever happened.
  await avoidBoundary();
  await call("/student/me/tap-context", { token: stuAbort.token }); // warm the socket, the pool and the config read
  const LADDER = [5, 3, 8, 2, 12, 18];
  let abortSession = null, abortMark = null, abortObserved = false, abortStatus = null, abortDelay = null;
  for (const delay of LADDER) {
    abortSession = await mkLiveSession(`concurrency aborted request ${delay}ms`, stuAbort);
    const ac = new AbortController();
    const inFlight = fetch(`${API}/student/me/qr-check-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${stuAbort.token}` },
      body: JSON.stringify({ sessionId: abortSession.id, code: codeFor(abortSession.id) }),
      signal: ac.signal,
    });
    const timer = setTimeout(() => ac.abort(), delay);
    abortObserved = false; abortStatus = null;
    try { abortStatus = (await inFlight).status; } catch (e) { abortObserved = e?.name === "AbortError"; }
    clearTimeout(timer);
    // The handler is still running — Express does not stop it when the socket closes —
    // so give its remaining writes a moment to land before deciding this attempt failed.
    abortMark = null;
    for (let i = 0; i < 20 && !abortMark; i += 1) { abortMark = await markFor(abortSession.id, stuAbort.id); if (!abortMark) await sleep(100); }
    if (abortObserved && abortMark) { abortDelay = delay; break; }
  }
  check("the client really did abandon the request before any answer reached it, and the server still handled it",
    abortObserved && Boolean(abortMark),
    abortDelay !== null
      ? `AbortError at ${abortDelay}ms, and the mark was written anyway`
      : abortObserved ? "every attempt aborted before the request was dispatched" : `the server answered first (HTTP ${abortStatus})`);
  check("NO ROLLBACK: the abandoned request still wrote its mark — the register records the scan",
    abortMark?.takenBy === SELF_CHECKIN_QR_STAMP, `takenBy=${abortMark?.takenBy || "no mark at all"}`);
  check("...exactly one mark, not a partial pair",
    await marksFor(abortSession.id, stuAbort.id) === 1, `${await marksFor(abortSession.id, stuAbort.id)} mark(s)`);
  const abortTaps = await db.tagTap.findMany({ where: { sessionId: abortSession.id, studentId: stuAbort.id, method: "qr" } });
  check("...and its log row went with it: no mark stranded without the account of how it was made",
    abortTaps.filter((t) => t.outcome === "marked").length === 1, abortTaps.map((t) => t.outcome).join(", ") || "none");
  const retryAfterAbort = await qrScan(stuAbort, abortSession);
  check("...and the phone's retry is idempotent: the standing mark, not a second one",
    retryAfterAbort.status === 200 && retryAfterAbort.data?.alreadyMarked === true && retryAfterAbort.data?.status === abortMark?.status,
    `HTTP ${retryAfterAbort.status} status=${retryAfterAbort.data?.status} db=${abortMark?.status}`);
  check("...and still exactly one mark after the retry",
    await marksFor(abortSession.id, stuAbort.id) === 1, `${await marksFor(abortSession.id, stuAbort.id)} mark(s)`);

  /* ====================================================================== */
  console.log("\n--- configuring Teams so the second writer exists ---");
  /* ====================================================================== */

  const savedIntegration = await call("/integrations/teams", {
    method: "PUT", token: adminToken,
    body: { tenantId: "fake-tenant", clientId: "fake-client", clientSecret: "fake-secret", organizerAccounts: ORG_EMAIL, enabled: true },
  });
  check("the Teams credentials save and report configured",
    savedIntegration.status === 200 && savedIntegration.data?.configured === true, `HTTP ${savedIntegration.status}`);
  const teamsOn = await call("/teams-attendance/settings", { method: "PUT", token: adminToken, body: { enabled: true, minAttendancePct: 50 } });
  check("...and Teams attendance is switched on for this run",
    teamsOn.status === 200 && teamsOn.data?.settings?.enabled === true, `HTTP ${teamsOn.status} enabled=${teamsOn.data?.settings?.enabled}`);
  // Everything after this point can create TeamsSync rows, so cleanup's scope starts here.
  runStart = new Date();
  const teamsUsable = savedIntegration.data?.configured === true && teamsOn.data?.settings?.enabled === true;
  if (!teamsUsable) throw new Error("Teams attendance could not be configured in this run — the cross-path blocks cannot be attempted, and reporting them as anything but a failure would hide the gap");

  const syncNow = () => call("/teams-attendance/sync", { method: "POST", token: runToken });

  /* ====================================================================== */
  console.log("\n--- C2. the state a run that died mid-session leaves behind ---");
  /* ====================================================================== */
  // THE ONE PARTIAL WRITE IN THIS FEATURE THAT CAN BE REPRODUCED EXACTLY, and it needs no
  // injected failure and no killed process — only the state planted below.
  //
  // teamsSync.js writes three times per session, outside any transaction:
  //
  //     1. createMany(marks, skipDuplicates)
  //     2. createMany(tagTap rows) — "marked" or "already_marked" per student
  //     3. update(session.teamsCollectedAt)
  //
  // A process that stops between 2 and 3 leaves a session fully marked and logged, but
  // still flagged as uncollected — so the next run collects it again. The code knows this
  // and says so in its own words: a mark carrying TEAMS_AUTO_STAMP is one this run wrote,
  // "(or, exactly once, a run that crashed after this createMany but before
  // teamsCollectedAt was set — a retry would then find its own prior write already
  // standing and correctly log THAT as 'already_marked', not double-count it as newly
  // marked)".
  //
  // That is the claim under test. The mark and the "marked" tap row below are exactly
  // what a run killed between steps 2 and 3 leaves, and the retry's log row is the
  // assertion. The planted mark is an L while the report says P, so the same run also
  // re-proves the never-overwrite invariant under recovery — a retry must not "correct"
  // the mark it finds.
  const crashUnit = await mkUnit("crashed run", [stuCrash]);
  const crashSession = await db.hndSession.create({ data: {
    unitId: crashUnit.id, date: YEST, startTime: "10:00", endTime: "11:30",
    description: "concurrency crashed run",
    teamsJoinUrl: joinUrl("crash"), teamsMeetingId: "m-crash", teamsOrganizerId: ORG_ID,
  } });
  made.sessions.push(crashSession.id);
  fixtures.meetingIds[joinUrl("crash")] = "m-crash";
  fixtures.attendanceByOccurrence["m-crash"] = [{
    date: YEST, intervals: [{ email: stuCrash.email, msUserId: null, intervals: [{ joinedAt: "10:00", leftAt: "11:30" }] }],
  }];
  writeFixtures();
  await db.attendanceMark.create({ data: {
    sessionId: crashSession.id, studentId: stuCrash.id, status: "L", remark: "",
    takenBy: TEAMS_AUTO_STAMP, checkedInAt: "10:20",
  } });
  await db.tagTap.create({ data: {
    studentId: stuCrash.id, sessionId: crashSession.id, method: "teams", outcome: "marked", status: "L",
  } });

  const recovery = await syncNow();
  check("the retry after a crashed run completes", recovery.status === 200, `HTTP ${recovery.status} ${recovery.data?.error || ""}`);
  const crashMark = await markFor(crashSession.id, stuCrash.id);
  check("the mark the dead run wrote is left exactly as it was — the retry does not re-decide it",
    crashMark?.status === "L" && crashMark?.checkedInAt === "10:20",
    `status=${crashMark?.status} checkedInAt=${crashMark?.checkedInAt} (P would mean the report overwrote it)`);
  check("...and no second mark was created for that student",
    await marksFor(crashSession.id, stuCrash.id) === 1, `${await marksFor(crashSession.id, stuCrash.id)} mark(s)`);
  const crashTaps = await db.tagTap.findMany({ where: { sessionId: crashSession.id, studentId: stuCrash.id, method: "teams" } });
  check("THE LOG MUST NOT DOUBLE-COUNT IT: the retry logs 'already_marked', as teamsSync.js promises, not a second 'marked'",
    crashTaps.filter((t) => t.outcome === "marked").length === 1 && crashTaps.filter((t) => t.outcome === "already_marked").length === 1,
    `outcomes [${crashTaps.map((t) => t.outcome).join(", ")}] — two 'marked' rows means the tap log says the sync marked one student twice`);
  const crashAfter = await db.hndSession.findUnique({ where: { id: crashSession.id } });
  check("...and the session is finally flagged collected, so the loop terminates",
    crashAfter?.teamsCollectedAt != null, `teamsCollectedAt=${crashAfter?.teamsCollectedAt}`);

  /* ====================================================================== */
  console.log("\n--- D1. a QR mark, then the Teams report that disagrees with it ---");
  /* ====================================================================== */
  // Order one of the cross-path collision, run sequentially ON PURPOSE: it is the
  // precedence rule, and a precedence rule has to be asserted in a known order before the
  // simultaneous case can mean anything. The student scanned the code in the room; the
  // meeting report says they were in the online class for the whole hour. One mark, and
  // the scan must survive: the Teams collector's `skipDuplicates` IS that promise.
  await avoidBoundary();
  const xpathA = await mkOverlapSession("concurrency cross-path: scan first", "m-xa", [stuD1]);
  const scanFirst = await qrScan(stuD1, xpathA);
  check("the scan lands while the class is held open past its end",
    scanFirst.status === 201, `HTTP ${scanFirst.status} ${scanFirst.data?.reason || ""}`);
  const syncAfterScan = await syncNow();
  check("the Teams sync then runs over the same register", syncAfterScan.status === 200, `HTTP ${syncAfterScan.status} ${syncAfterScan.data?.error || ""}`);
  const xpathAMark = await markFor(xpathA.id, stuD1.id);
  check("THE SCAN WINS: the mark is still the student's own check-in, with its own arrival minute",
    xpathAMark?.takenBy === SELF_CHECKIN_QR_STAMP && xpathAMark?.status === scanFirst.data?.status,
    `takenBy=${xpathAMark?.takenBy} status=${xpathAMark?.status} (scan said ${scanFirst.data?.status})`);
  check("...and there is one mark, not one per capture path",
    await marksFor(xpathA.id, stuD1.id) === 1, `${await marksFor(xpathA.id, stuD1.id)} mark(s)`);
  const xpathATeamsTap = await db.tagTap.findFirst({ where: { sessionId: xpathA.id, studentId: stuD1.id, method: "teams" } });
  check("...and the sync logs its refusal to overwrite, carrying no status of its own",
    xpathATeamsTap?.outcome === "already_marked" && xpathATeamsTap?.status == null,
    `outcome=${xpathATeamsTap?.outcome} status=${xpathATeamsTap?.status}`);

  /* ====================================================================== */
  console.log("\n--- D2. the same collision in the other order ---");
  /* ====================================================================== */
  // The order that matters more, because here the LOSER is a student holding a phone. The
  // sync has already written a mark from the meeting report; the student then scans the
  // code on the screen. The mark must not move — and the student must be told what
  // actually stands rather than that their scan wrote it, which is the same ruling
  // routes/checkins.js made for its clock-in button.
  await avoidBoundary();
  const xpathB = await mkOverlapSession("concurrency cross-path: sync first", "m-xb", [stuD2]);
  const syncFirst = await syncNow();
  check("the Teams sync collects the held-open register", syncFirst.status === 200, `HTTP ${syncFirst.status} ${syncFirst.data?.error || ""}`);
  const teamsMark = await markFor(xpathB.id, stuD2.id);
  check("...and writes the mark its report supports",
    teamsMark?.takenBy === TEAMS_AUTO_STAMP, `takenBy=${teamsMark?.takenBy} status=${teamsMark?.status}`);
  const scanSecond = await qrScan(stuD2, xpathB);
  check("the student's scan is then an idempotent repeat: 200, never 201",
    scanSecond.status === 200 && scanSecond.data?.alreadyMarked === true, `HTTP ${scanSecond.status}`);
  check("...and it reports the mark that STANDS, not the one it would have written",
    scanSecond.data?.status === teamsMark?.status, `answered ${scanSecond.data?.status}, db holds ${teamsMark?.status}`);
  const teamsMarkAfter = await markFor(xpathB.id, stuD2.id);
  check("...the Teams mark is untouched: no status flip, no arrival time rewritten",
    teamsMarkAfter?.takenBy === TEAMS_AUTO_STAMP && teamsMarkAfter?.status === teamsMark?.status && teamsMarkAfter?.checkedInAt === teamsMark?.checkedInAt,
    `takenBy=${teamsMarkAfter?.takenBy} status=${teamsMarkAfter?.status} checkedInAt=${teamsMarkAfter?.checkedInAt}`);
  check("...and still exactly one mark",
    await marksFor(xpathB.id, stuD2.id) === 1, `${await marksFor(xpathB.id, stuD2.id)} mark(s)`);

  /* ====================================================================== */
  console.log("\n--- D3. the two paths genuinely at the same instant ---");
  /* ====================================================================== */
  // D1 and D2 pin the rule; this is the collision itself, and no assertion below depends
  // on which way it falls — only on the answer and the row agreeing afterwards.
  //
  // THE BALLAST IS THE PROOF OF OVERLAP. A sync with one session to collect finishes in a
  // few milliseconds, and a "concurrent" scan would very likely land after it — a test
  // that passes because nothing overlapped, which is worth less than no test. Ten extra
  // eligible registers make the run take long enough that the scan demonstrably lands
  // inside it, and the overlap is then ASSERTED rather than assumed: the tap row the scan
  // wrote carries a timestamp, the run row carries its start and finish, and the first
  // must lie between the other two. If a future change makes the run fast again, that
  // assertion fails rather than quietly stopping to discriminate.
  //
  // The 25ms stagger exists for the same reason and does NOT settle the race: it only
  // guarantees the run ROW exists (so there is a startedAt to compare against) before the
  // scan is sent. Which writer reaches the unique constraint first still depends on where
  // in its list of eleven registers the sync happens to be.
  // TWO COLLIDING REGISTERS, ONE EARLY IN THE RUN AND ONE LATE, because the first
  // version of this block only ever produced one of the two interleavings. The collector
  // walks its eligible sessions in the order the database hands them back, so a register
  // created BEFORE the ballast is reached while the scan is still being authenticated
  // (the sync tends to win), and one created AFTER it is reached long after the scan has
  // finished (the scan tends to win). Neither is asserted — "tends to" is the whole point
  // and the notes below report which way each actually fell — but running both means this
  // block exercises both directions of the race rather than whichever one the insert
  // order happens to favour on this machine.
  const xpathEarly = await mkOverlapSession("concurrency cross-path: simultaneous, early", "m-xc0", [stuD3]);
  await mkBallast("d3", 10);
  const xpathLate = await mkOverlapSession("concurrency cross-path: simultaneous, late", "m-xc1", [stuD3]);
  await avoidBoundary();
  const syncP = syncNow();
  // The 25ms stagger does NOT settle the race: it only guarantees the run ROW exists (so
  // there is a startedAt to compare a timestamp against) before the scans are sent.
  await sleep(25);
  const scansP = Promise.all([qrScan(stuD3, xpathEarly), qrScan(stuD3, xpathLate)]);
  const [syncBoth, scans] = await Promise.all([syncP, scansP]);
  check("the simultaneous sync completes", syncBoth.status === 200, `HTTP ${syncBoth.status} ${syncBoth.data?.error || ""}`);

  const d3Run = await db.teamsSync.findFirst({ orderBy: { startedAt: "desc" } });
  const runMs = d3Run?.finishedAt && d3Run?.startedAt ? new Date(d3Run.finishedAt) - new Date(d3Run.startedAt) : null;
  check("...and it was long enough for a concurrent request to be inside it at all",
    runMs !== null && runMs >= 50, `the run took ${runMs}ms (under 50ms and a 'concurrent' scan is not reliably inside it)`);

  for (const [label, session, scan] of [["early", xpathEarly, scans[0]], ["late", xpathLate, scans[1]]]) {
    check(`the ${label} simultaneous scan is answered without a server error`,
      scan.status === 201 || (scan.status === 200 && scan.data?.alreadyMarked === true),
      `HTTP ${scan.status} ${scan.data?.reason || ""}`);
    const count = await marksFor(session.id, stuD3.id);
    check(`...ONE MARK on the ${label} register, whichever path got there first`, count === 1, `${count} mark(s)`);
    const mark = await markFor(session.id, stuD3.id);
    check(`...stamped by exactly one of the two writers, never a blend of both (${label})`,
      mark?.takenBy === SELF_CHECKIN_QR_STAMP || mark?.takenBy === TEAMS_AUTO_STAMP, `takenBy=${mark?.takenBy}`);
    // The coherence assertion, and the one a lost update would break: a 201 means this
    // request created the row, so the row must be ITS mark; a 200 alreadyMarked means it
    // did not, so the row must be the other writer's and the status it reported must be
    // the status that stands. Either way the student was not lied to about their own mark.
    const coherent = scan.status === 201
      ? mark?.takenBy === SELF_CHECKIN_QR_STAMP && mark?.status === scan.data?.status
      : mark?.status === scan.data?.status;
    check(`...and the answer the student got matches the row that exists (${label})`,
      coherent, `HTTP ${scan.status} said ${scan.data?.status}; db holds ${mark?.status} by ${mark?.takenBy}`);
    // THE PROOF THAT THE OVERLAP HAPPENED, rather than an assumption that it did. The tap
    // row the scan wrote carries a database timestamp; the run row carries its start and
    // its finish; the first must lie between the other two. A future change that makes
    // the run fast again fails this rather than quietly ceasing to overlap.
    const tap = await db.tagTap.findFirst({ where: { sessionId: session.id, studentId: stuD3.id, method: "qr" }, orderBy: { at: "desc" } });
    check(`THE OVERLAP REALLY HAPPENED (${label}): the scan was handled between the run's start and finish`,
      Boolean(tap && d3Run?.finishedAt) && new Date(tap.at) >= new Date(d3Run.startedAt) && new Date(tap.at) <= new Date(d3Run.finishedAt),
      `run ${d3Run?.startedAt?.toISOString?.()} → ${d3Run?.finishedAt?.toISOString?.()}, scan logged ${tap?.at?.toISOString?.()}`);
    note(`the ${label} collision was won by ${mark?.takenBy === TEAMS_AUTO_STAMP ? "the Teams sync" : "the QR scan"} this time — either is correct, and the race is why this is a note rather than an assertion`);
  }

  /* ====================================================================== */
  console.log("\n--- E. two syncs at once: the in-process run guard ---");
  /* ====================================================================== */
  // conventions.md: every lock in this codebase is an in-process module-level value,
  // "correct for one Node process; a clustered deployment needs Redis". teamsSync.js's
  // guard is a `let running = false` with exactly that caveat written on it, and it is
  // checked twice — once in routes/teamsAttendance.js (answering 409) and once at the top
  // of runSyncInner (throwing, which the route turns into 502).
  //
  // What must hold, whichever of the two catches it: exactly ONE run happens. Two
  // concurrent runs would both fetch the same reports and both write the same marks —
  // survivable only because of the unique constraint, and the duplicate "marked" rows in
  // the tap log would not be survivable at all.
  //
  // Ballast again, for the same reason as block D3: a sync with nothing to do returns
  // before the second request has been parsed, and the guard would never be exercised.
  await mkBallast("e", 10);
  const runsBefore = await db.teamsSync.count();
  const [syncOne, syncTwo] = await Promise.all([syncNow(), syncNow()]);
  const statuses = [syncOne.status, syncTwo.status];
  check("exactly one of two simultaneous syncs is allowed to run",
    statuses.filter((s) => s === 200).length === 1, `statuses ${statuses.join(", ")}`);
  const loser = [syncOne, syncTwo].find((r) => r.status !== 200);
  check("...and the other is refused for being a duplicate, in words that say so",
    /already running/i.test(loser?.data?.error || ""), `HTTP ${loser?.status} ${loser?.data?.error || ""}`);
  const runsAfter = await db.teamsSync.count();
  check("...and only ONE run row was written: the refused request started nothing",
    runsAfter - runsBefore === 1, `${runsAfter - runsBefore} new run row(s)`);
  note(`the duplicate sync answered HTTP ${loser?.status} — 409 when routes/teamsAttendance.js's isRunning() check catches it, 502 when the engine's own throw does; both are refusals, and the pair is reported in the audit rather than asserted`);

  /* ====================================================================== */
  console.log("\n--- F. staff presence: the clock-in and clock-out races ---");
  /* ====================================================================== */
  // The route whose comment this whole suite is modelled on. `site: "Online"` throughout:
  // Online is never place-checked under any setting (refusedForStaffPlace), so nothing
  // here depends on where the machine running the tests thinks it is.
  const mkStaff = async (label) => {
    const id = `conc-${label}-${RUN}`;
    const email = `${id}@edtech.co.uk`;
    await db.staff.create({ data: {
      id, name: `Concurrency ${label}`, jobTitle: "Lecturer", dept: "Concurrency Suite",
      email, passwordHash: S_HASH, initials: "CC", colour: "#888888",
    } });
    made.staff.push(id);
    const tok = (await login(email, S_PASSWORD)).data?.token;
    if (!tok) throw new Error(`staff ${label} sign-in failed — cannot run this suite`);
    return { id, email, token: tok };
  };
  const staffIn = await mkStaff("in");
  const clockIn = (s) => call("/checkins/check-in", { method: "POST", token: s.token, body: { site: "Online" } });

  const presses = await Promise.all([clockIn(staffIn), clockIn(staffIn), clockIn(staffIn)]);
  const pressStatuses = presses.map((r) => r.status);
  check("three simultaneous clock-in presses: exactly one 201",
    pressStatuses.filter((s) => s === 201).length === 1, `statuses ${pressStatuses.join(", ")}`);
  check("...the others 200 with the row that stands — 'they are clocked in' is the fact they pressed for",
    pressStatuses.filter((s) => s === 200).length === 2, `statuses ${pressStatuses.join(", ")}`);
  check("...and no unhandled P2002 surfaced as a 500",
    pressStatuses.every((s) => s < 500), `statuses ${pressStatuses.join(", ")}`);
  const inRows = await db.checkIn.count({ where: { staffId: staffIn.id } });
  check("...and exactly one check-in row exists for the day",
    inRows === 1, `${inRows} row(s)`);
  const inRow = await db.checkIn.findFirst({ where: { staffId: staffIn.id } });
  check("...with ONE arrival time, agreed by every answer",
    presses.every((r) => r.data?.in === inRow?.timeIn), `db=${inRow?.timeIn} answers=[${presses.map((r) => r.data?.in).join(", ")}]`);

  // THE CHECK-OUT RACE. The route reads the row, refuses if `timeOut` is already set, then
  // updates — a read-then-write with nothing in the statement to settle a collision, and
  // the invariant it is defending is explicit in its own comment: "Checking out twice
  // silently rewrote the recorded departure to the current clock, with no trace of the
  // original. A stale tab or a retry could therefore falsify how long someone was on site,
  // so the first check-out is final."
  //
  // Two simultaneous presses are exactly the stale tab and the retry that comment names.
  // "Final" has to mean one of them is told no — and if both are told yes, both wrote, and
  // in the one case that matters (the two presses landing either side of a minute
  // boundary) the recorded departure moves. The same minute hides the damage; it does not
  // remove it.
  const checkOutUrl = `/checkins/${inRow?.id}/check-out`;
  const outs = await Promise.all([
    call(checkOutUrl, { method: "POST", token: staffIn.token }),
    call(checkOutUrl, { method: "POST", token: staffIn.token }),
  ]);
  const outStatuses = outs.map((r) => r.status);
  check("THE FIRST CHECK-OUT IS FINAL: of two simultaneous presses, exactly one is accepted",
    outStatuses.filter((s) => s === 200).length === 1, `statuses ${outStatuses.join(", ")}`);
  check("...and the other is refused as already checked out",
    outStatuses.filter((s) => s === 409).length === 1,
    `statuses ${outStatuses.join(", ")} — two 200s mean both requests wrote the departure time`);
  const outRow = await db.checkIn.findFirst({ where: { staffId: staffIn.id } });
  check("...and a departure time stands afterwards",
    Boolean(outRow?.timeOut), `timeOut=${outRow?.timeOut}`);

  // CLOCK-IN AND CLOCK-OUT AT THE SAME INSTANT, on a second account: the morning's stale
  // tab re-pressing "On site" while the person presses "Leave". The clock-in must stay a
  // no-op (the arrival time already stands and re-pressing must never move it) and must
  // not resurrect the row as "still here".
  const staffBoth = await mkStaff("both");
  const firstIn = await clockIn(staffBoth);
  check("the second account is clocked in", firstIn.status === 201, `HTTP ${firstIn.status}`);
  const bothRow = firstIn.data;
  const [reIn, outConcurrent] = await Promise.all([
    clockIn(staffBoth),
    call(`/checkins/${bothRow?.id}/check-out`, { method: "POST", token: staffBoth.token }),
  ]);
  check("a clock-in press simultaneous with a clock-out is answered without error",
    reIn.status < 500 && outConcurrent.status < 500, `in=${reIn.status} out=${outConcurrent.status}`);
  const bothAfter = await db.checkIn.findFirst({ where: { staffId: staffBoth.id } });
  check("...the arrival time was not moved by the re-press",
    bothAfter?.timeIn === bothRow?.in, `before=${bothRow?.in} after=${bothAfter?.timeIn}`);
  check("...the departure was recorded and not wiped by the request racing it",
    Boolean(bothAfter?.timeOut), `timeOut=${bothAfter?.timeOut}`);
  check("...and there is still exactly one row for the day",
    await db.checkIn.count({ where: { staffId: staffBoth.id } }) === 1,
    `${await db.checkIn.count({ where: { staffId: staffBoth.id } })} row(s)`);

  /* ====================================================================== */
  console.log("\n--- G. six administrators saving the settings at once ---");
  /* ====================================================================== */
  // The singleton config row (attendanceTapConfig.js). Its save path is an upsert on the
  // literal key "singleton", and the comment on that key states exactly what the key buys
  // and what it does not: the upsert "makes two concurrent saves collide on the key rather
  // than both succeeding", while "the read above is still a read-modify-write and so still
  // races on the CONTENT of the patch — the loser's field is overwritten by the winner".
  //
  // So two assertions and one note. The assertions are the promises: ONE row, whatever
  // happens, and a stored value that is one somebody actually sent — never a blend, never
  // a default that nobody asked for, never a 500. The note is the admitted last-write-wins,
  // which no assertion can pin without pretending the race has an outcome.
  //
  // Last of the suite deliberately: it writes the row every block above reads.
  //
  // THE ROW IS DELETED FIRST, and that is what makes the one-row assertion discriminate
  // anything at all. With a row already present every save takes the upsert's UPDATE
  // branch, and find-then-create would behave identically — so the assertion would pass
  // against the very defect it exists to catch. "No settings row yet" is also the state
  // of every college that has never opened the screen, which is exactly when six
  // administrators pressing Save at once can each find nothing and each create something.
  // cleanup() restores the row with the same upsert-on-"singleton" idiom
  // smoke-qr-checkin.mjs uses, for the same reason: a throw inside this window must not
  // leave the institution's real settings deleted.
  await db.attendanceTapConfig.deleteMany({});
  const sent = [11, 12, 13, 14, 16, 17];
  const saves = await Promise.all(sent.map((lateAfterMins) =>
    call("/tags/settings", { method: "PUT", token: adminToken, body: { lateAfterMins } })));
  check("six simultaneous settings saves: none of them fails",
    saves.every((r) => r.status === 200), `statuses ${saves.map((r) => r.status).join(", ")}`);
  const rows = await db.attendanceTapConfig.count();
  check("...and there is still exactly ONE settings row — the constant key, not find-then-create",
    rows === 1, `${rows} row(s)`);
  const storedAfter = await db.attendanceTapConfig.findFirst({});
  const storedLate = (storedAfter?.settings ?? {}).lateAfterMins;
  check("...the stored threshold is one somebody actually sent, not a default or a blend",
    sent.includes(storedLate), `stored=${JSON.stringify(storedLate)} sent=[${sent.join(", ")}]`);
  // The six patches named ONE field each. Whichever of them wrote the row, every other
  // field must be resolvable — merged from the shipped defaults here, since the row was
  // deleted — rather than absent or null, because a settings blob with holes in it is
  // read on every single scan.
  check("...and the fields nobody patched are still resolvable, not holes",
    (storedAfter?.settings ?? {}).qrEnabled === true && (storedAfter?.settings ?? {}).enabled === false,
    `qrEnabled=${JSON.stringify((storedAfter?.settings ?? {}).qrEnabled)} enabled=${JSON.stringify((storedAfter?.settings ?? {}).enabled)}`);
  note(`the six saves resolved to lateAfterMins=${storedLate}; the other five fields were overwritten by the winner, which is the last-write-wins attendanceTapConfig.js documents and does not claim to prevent`);

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
