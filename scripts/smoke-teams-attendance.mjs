// Teams auto-attendance — the pipeline, weighted toward what it must never do.
//
// A Teams meeting's attendance report becomes a class register once a sync run reads
// it: present/late/absent from minutes attended, matched to a timetabled session by
// date+time (and, when two classes share a slot, by title). Most of what matters about
// that pipeline is what it REFUSES to do, so most of the assertions below are refusals:
//
//   * a lecturer's mark is NEVER overwritten, whatever the meeting report says — the
//     human in the room wins, exactly as moodleAttendance.js and every tap/scan suite
//     already prove for their own capture methods;
//   * an unmatched participant (on the call, on no roster) is reported, never guessed
//     onto anybody's register;
//   * a report that could not be fetched writes NOTHING — not even an Absent — because
//     "we don't know" and "we know they were absent" must never look the same on a
//     register a college is asked to defend at a funding audit;
//   * an ambiguous meeting (two classes, one slot, a title that does not disambiguate)
//     writes NO url onto EITHER candidate rather than guessing;
//   * a future register is never touched, however confidently a meeting is matched to it;
//   * collection is idempotent — a second sync against an already-collected session
//     writes nothing new, which is what makes an hourly poller safe to run at all;
//   * an admin's pasted join link always beats the calendar matcher — discovery fills a
//     BLANK teamsJoinUrl only, and never overwrites one that is already there, even when
//     a competing meeting on the calendar lands on the exact same date and time.
//
// THE FIXTURES SEAM. teamsGraph.js answers every Graph call from a JSON file named by
// TEAMS_GRAPH_FIXTURES, read fresh on every call, so this suite drives the whole pipeline
// — discovery, matching, report-fetch, decision, write — without a Microsoft tenant.
//
// THE API PROCESS THIS SUITE TALKS TO IS ITS OWN, NOT THE SHARED ONE. `npm test` boots
// one API on port 4010 and hands every suite the SAME env — there is no per-suite
// override, and the fixtures seam is an env var the API must have been STARTED with, not
// something that can be poked in after the fact. So this suite spawns its own API on a
// spare port, with TEAMS_GRAPH_FIXTURES pointing at a file it writes itself, runs every
// assertion against that instance, and kills it — the same DATABASE_URL and the same
// already-seeded fixtures (admin@edtech.co.uk et al.) as everything else in this run,
// just a second process with a different environment sitting in front of them.
//
// A throwaway CREDENTIALS_KEY is generated per run (32 random bytes, base64) rather than
// reusing whatever the outer `npm test` set, so this suite is self-contained and can also
// be run on its own: `node scripts/smoke-teams-attendance.mjs` with only DATABASE_URL set.
//
//   node scripts/smoke-teams-attendance.mjs
//   (needs DATABASE_URL; SEED_PASSWORD defaults to the one `npm test` seeds with)
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { collegeWideReader } from "./lib/college-wide-reader.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const server = join(root, "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

// Exit 2 = SKIP (the runner's convention: a suite that could not run is not the same as
// one whose assertions passed). DATABASE_URL is the one precondition this suite cannot
// work around — without it there is no database to spawn an API against at all.
if (!process.env.DATABASE_URL) {
  console.log("SKIP — DATABASE_URL is not set, so there is no database to run this suite against");
  process.exit(2);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));

const RUN = Date.now().toString(36);
const PORT = Number(process.env.TEAMS_SMOKE_PORT || 4017);
const API = `http://127.0.0.1:${PORT}/api`;
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;
const SEED_PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
// Never the outer run's key: this suite spawns its OWN API process and must hand it a
// key that process alone knows about, so a run of this suite never depends on (or
// leaks into) whatever `npm test` happened to configure for the shared instance.
const CREDENTIALS_KEY = randomBytes(32).toString("base64");
const JWT_SECRET = "teams-smoke-secret-not-for-production";
const FIXTURES_PATH = join(tmpdir(), `teams-graph-fixtures-${RUN}.json`);

const ZONE = process.env.APP_TIMEZONE || "Europe/London";
const isoOffset = (days) => new Date(Date.now() + days * 86400000).toLocaleDateString("en-CA", { timeZone: ZONE });
const TODAY = isoOffset(0), YEST = isoOffset(-1), TOM = isoOffset(1);
// Task 10's recurring-meeting scenario needs two DIFFERENT past dates, both inside the
// RETRY_DAYS(7) collection window (teamsSync.js: daysAgo(7)..today) so both registers
// are actually eligible for collection in this run, rather than one landing in the
// future (skipped, "never touched") or outside the window (never collected at all).
const WEEK1 = isoOffset(-6), WEEK2 = YEST;

// A bare client, exactly as smoke-qr-checkin.mjs uses one: this suite plants fixtures
// the API's own routes would refuse to create directly (a lecturer's mark, an event
// already published) and reads back what the sync actually wrote.
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function call(path, { method = "GET", body, token, headers: extra } = {}) {
  const headers = { "Content-Type": "application/json", ...(extra || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}
const login = (email, password) => call("/auth/login", { method: "POST", body: { email, password } });

// --- Emails, all RUN-suffixed so a run never collides with a previous one's leftovers.
const S1_EMAIL = `s1-${RUN}@x.ac.uk`;
const S2_EMAIL = `s2-${RUN}@x.ac.uk`;
const S3_EMAIL = `s3-${RUN}@x.ac.uk`;
const STRANGER_EMAIL = `stranger-${RUN}@gmail.com`;
const ORG_EMAIL = `organizer-${RUN}@x.ac.uk`;
const ORG_ID = "org1";
// Task 10's two-student roster for the recurring-meeting scenario. RUN-suffixed like
// every other identifier here (both the email and the Graph-side msUserId, which lands
// on Student.msUserId — a @@unique column — so a leftover value from a previous run
// could otherwise collide with this one's).
const ALICE_EMAIL = `alice-${RUN}@x.ac.uk`;
const BOB_EMAIL = `bob-${RUN}@x.ac.uk`;
const ALICE_MSID = `ms-alice-${RUN}`;
const BOB_MSID = `ms-bob-${RUN}`;

// A valid-shaped join link is all parseJoinUrl asks for (see teamsAttendance.js); the
// suffix only needs to be unique per meeting.
const joinUrl = (n) => `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${RUN}_${n}%40thread.v2/0`;
const URL_A = joinUrl("a"); // yesterday 09:07 — the happy path
const URL_B = joinUrl("b"); // tomorrow — matched, never collected
const URL_C = joinUrl("c"); // yesterday 11:19 — the failed-fetch case
const URL_D = joinUrl("d"); // yesterday 13:31 — the ambiguous slot
const URL_E = joinUrl("e"); // a personal meeting at a time nothing is timetabled
const URL_F_PASTED = joinUrl("f-pasted"); // yesterday 16:45 — already on the session, an admin's paste
const URL_F_COMPETING = joinUrl("f-competing"); // a DIFFERENT meeting the calendar offers at the same slot
const URL_SERIES = joinUrl("series"); // ONE recurring link, shared by two registers on two different dates

// Times deliberately NOT on the hour or half hour. prisma/seed.js times its own weekly
// timetable at 10:00/14:00/18:00 on fixed weekdays computed relative to today — a real
// college session teamsSync's discovery would see and treat as an extra CANDIDATE at
// whatever slot happens to fall on "yesterday". Landing on an odd minute keeps this
// suite's slots from ever coinciding with that timetable, on any day it happens to run.
const T = {
  a: { start: "09:07", end: "10:37" },
  c: { start: "11:19", end: "12:49" },
  d: { start: "13:31", end: "15:01" },
  e: { start: "20:53", end: "21:23" },
  f: { start: "16:45", end: "18:15" },
  g: { start: "08:13", end: "09:43" }, // the recurring meeting's slot, on both WEEK1 and WEEK2
};

const made = { sessions: [], events: [], enrolments: [], marks: [], students: [] };
let unit = null, cohort = null, course = null;
// Task 10's recurring-meeting scenario gets its own unit and cohort — alice and bob are
// its ONLY roster, deliberately isolated from the three-student cohort the rest of this
// suite shares, so a stray s1/s2/s3 mark can never be mistaken for (or mask) the
// per-week separation this scenario exists to pin.
let unit2 = null, cohort2 = null;
let child = null, bootLog = "";
let integrationExisted = false, priorIntegration = null;
let teamsConfigExisted = false, priorTeamsConfig = null;
let priorAdminPages;
let runStart; // set just before the first sync — see cleanup()'s use of it

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

// The throwaway college-wide account the run calls use in the scoped pass, disposed of in
// cleanup() like every other fixture. Module level because cleanup() is defined above the
// try block that makes it, and a college-wide admin left behind would be a permission this
// suite granted to every suite that sorts after it.
let disposeRunner = async () => {};

async function cleanup() {
  try {
    await disposeRunner().catch(() => {});
    await db.tagTap.deleteMany({ where: { sessionId: { in: made.sessions } } }).catch(() => {});
    for (const id of made.marks) await db.attendanceMark.delete({ where: { id } }).catch(() => {});
    for (const id of made.sessions) await db.hndSession.delete({ where: { id } }).catch(() => {});
    for (const id of made.events) await db.timetableEvent.delete({ where: { id } }).catch(() => {}); // groups cascade
    for (const id of made.enrolments) await db.enrolment.delete({ where: { id } }).catch(() => {});
    if (unit) await db.unit.delete({ where: { id: unit.id } }).catch(() => {});
    if (unit2) await db.unit.delete({ where: { id: unit2.id } }).catch(() => {});
    for (const id of made.students) await db.student.delete({ where: { id } }).catch(() => {});
    if (cohort) await db.cohort.delete({ where: { id: cohort.id } }).catch(() => {});
    if (cohort2) await db.cohort.delete({ where: { id: cohort2.id } }).catch(() => {});
    if (course) await db.course.delete({ where: { id: course.id } }).catch(() => {});

    // This suite's own runs, only — scoped by startedAt rather than a bare deleteMany({}).
    // Nothing else in an isolated DATABASE_URL writes TeamsSync rows during this suite's
    // lifetime today (the shared API on port 4010, if running at all, never sees
    // TEAMS_GRAPH_FIXTURES and never gets asked to sync), but a bare deleteMany({}) would
    // silently take down anything that ever does, whereas this one only ever reaches rows
    // this run itself could have created. runStart is undefined if the suite bailed before
    // ever reaching the sync section, in which case there is nothing of this run's to find.
    if (runStart) await db.teamsSync.deleteMany({ where: { startedAt: { gte: runStart } } }).catch(() => {});

    // Put the "teams" integration and TeamsAttendanceConfig back exactly as found —
    // the same upsert-on-singleton idiom smoke-qr-checkin.mjs uses for tap settings,
    // for the same reason: a college left switched ON is the one piece of state here
    // that would otherwise change the real product.
    if (integrationExisted) {
      const { id, ...rest } = priorIntegration;
      await db.tenantIntegration.update({ where: { id }, data: rest }).catch(() => {});
    } else {
      await db.tenantIntegration.deleteMany({ where: { provider: "teams" } }).catch(() => {});
    }
    if (teamsConfigExisted) {
      await db.teamsAttendanceConfig.upsert({
        where: { id: "singleton" }, update: { settings: priorTeamsConfig }, create: { id: "singleton", settings: priorTeamsConfig },
      }).catch(() => {});
    } else {
      await db.teamsAttendanceConfig.deleteMany({}).catch(() => {});
    }
    if (priorAdminPages !== undefined) {
      await db.staff.update({ where: { id: "admin" }, data: { adminPages: priorAdminPages } }).catch(() => {});
    }
  } catch (e) {
    console.error("cleanup problem:", e.message);
  }
  try { unlinkSync(FIXTURES_PATH); } catch { /* never written, or already gone */ }
}

try {
  // ====================================================================================
  // Fixtures file FIRST — it must exist on disk before the API process that reads it
  // (fresh, on every call) is even spawned.
  // ====================================================================================
  const fixtures = {
    organizers: [{ email: ORG_EMAIL, id: ORG_ID }],
    calendars: {
      [ORG_ID]: [
        { subject: `Teams Suite Class ${RUN}`, date: YEST, startTime: T.a.start, endTime: T.a.end, joinUrl: URL_A },
        { subject: `Teams Suite Tomorrow ${RUN}`, date: TOM, startTime: T.a.start, endTime: T.a.end, joinUrl: URL_B },
        { subject: `Teams Suite Failed Fetch ${RUN}`, date: YEST, startTime: T.c.start, endTime: T.c.end, joinUrl: URL_C },
        // An unhelpful subject on purpose — it must not line up with either candidate's
        // title, or the ambiguity this meeting is here to exercise never happens.
        { subject: "Weekly Sync", date: YEST, startTime: T.d.start, endTime: T.d.end, joinUrl: URL_D },
        // A staff meeting on the same calendar, at a time nothing is timetabled. Discovery
        // must ignore it silently (matchMeeting's "none") rather than force a match.
        { subject: "Personal 1:1", date: YEST, startTime: T.e.start, endTime: T.e.end, joinUrl: URL_E },
        // A COMPETING meeting at the exact slot the pasted session already occupies, with
        // a DIFFERENT join url. matchMeeting sees exactly one candidate here (session F's
        // own group) and would happily match it — the point of this fixture is that
        // discovery's own `teamsJoinUrl: null` guard never lets that match land, because
        // session F does not have a blank to fill.
        { subject: "Teams Suite Pasted Slot Competitor", date: YEST, startTime: T.f.start, endTime: T.f.end, joinUrl: URL_F_COMPETING },
      ],
    },
    meetingIds: {
      [URL_A]: "m-a", [URL_C]: "m-c", [URL_B]: "m-b", [URL_F_PASTED]: "m-f", [URL_F_COMPETING]: "m-f-competing",
      [URL_SERIES]: "mtg-series-1",
    },
    // Task 10 replaced the old attendanceIntervals(org, meetingId) — a bare participants
    // list per meeting id, read from `fixtures().attendance` — with
    // attendanceByOccurrence(org, meetingId): ONE ENTRY PER HELD OCCURRENCE, each tagged
    // with that occurrence's own DATE (teamsGraph.js), and matched to a register by
    // occurrenceForDate() in teamsAttendance.js, which reads ONLY the occurrence whose
    // date equals the session being collected. Every scenario below that used to hand a
    // bare participants array under `attendance` now wraps that SAME array as the sole
    // occurrence of `attendanceByOccurrence`, dated to the one session it feeds — get the
    // date wrong here and occurrenceForDate finds nothing, which collects as "no report",
    // not as a mismatch, so it fails exactly as silently as it would in production.
    attendanceByOccurrence: {
      "m-a": [
        { date: YEST, intervals: [
          // student1: the report says they attended in full. Irrelevant to the outcome —
          // the point of this fixture is that a LECTURER'S mark already stands here and
          // must survive no matter what the report claims.
          { email: S1_EMAIL, msUserId: null, intervals: [{ joinedAt: T.a.start, leftAt: "10:27" }] },
          // student2: joins twenty minutes in — past lateAfterMins (15) added to the
          // 09:07 start, i.e. after 09:22 — so this is the Late case.
          { email: S2_EMAIL, msUserId: null, intervals: [{ joinedAt: "09:27", leftAt: T.a.end }] },
          // On the call, on no roster this college can see. Reported, never guessed.
          { email: STRANGER_EMAIL, msUserId: null, intervals: [{ joinedAt: "09:10", leftAt: "09:20" }] },
          // student3 has NO entry at all: rostered, report fetched successfully, never
          // joined — the "actually absent" case, as opposed to "we don't know" below.
        ] },
      ],
      // "m-c" IS DELIBERATELY ABSENT. teamsGraph.js's fixture branch throws for a
      // meeting id with no key here rather than answering [] — a fetch that failed must
      // not read like a report that succeeded and found nobody.
      //
      // "m-f" is the PASTED meeting's report, not the competing one's — "m-f-competing"
      // has no entry at all, and must never be asked for, because nothing ever lets its
      // url reach a session's teamsJoinUrl in the first place.
      "m-f": [
        { date: YEST, intervals: [
          { email: S1_EMAIL, msUserId: null, intervals: [{ joinedAt: "16:47", leftAt: "18:10" }] },
        ] },
      ],
      // Task 10's own scenario: ONE recurring meeting id shared by two registers on
      // DIFFERENT dates, reported as TWO occurrences — alice attended WEEK1's meeting
      // only, bob attended WEEK2's only. Nothing here merges the weeks; the bug this
      // pins is a collector that used to flatten every occurrence of a meeting id into
      // one set of participants, which would have credited BOTH students onto BOTH
      // registers regardless of which week each of them actually attended.
      "mtg-series-1": [
        { date: WEEK1, intervals: [
          { email: ALICE_EMAIL, msUserId: ALICE_MSID, intervals: [{ joinedAt: T.g.start, leftAt: T.g.end }] },
        ] },
        { date: WEEK2, intervals: [
          { email: BOB_EMAIL, msUserId: BOB_MSID, intervals: [{ joinedAt: T.g.start, leftAt: T.g.end }] },
        ] },
      ],
    },
  };
  writeFileSync(FIXTURES_PATH, JSON.stringify(fixtures, null, 2));

  // ====================================================================================
  // This suite's own API, spawned on a spare port with the fixtures seam wired in.
  // ====================================================================================
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
      // No caches: this suite writes settings, expects the very next call to see them,
      // and — unlike the shared runner — controls this whole process itself, so there is
      // nothing lost by disabling every short-lived cache in the path.
      ATTENDANCE_TAP_CACHE_MS: "0",
      TEAMS_ATTENDANCE_CACHE_MS: "0",
      INTEGRATION_CACHE_MS: "0",
    },
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

  // ====================================================================================
  // Seed: unit, cohort, three students, an enrolment each, a published TimetableEvent
  // per register — mirroring smoke-qr-checkin.mjs's own-timetable idiom, via the bare
  // Prisma client rather than any publish endpoint, so this suite controls every field
  // teamsSync.js reads without depending on syncEventRegisters' own roster derivation.
  // ====================================================================================
  const adminLogin = await login("admin@edtech.co.uk", SEED_PASSWORD);
  const adminToken = adminLogin.data?.token;
  // THE TEAMS RUNS ARE WHOLE-COLLEGE JOBS and need a college-wide caller since
  // 28 Sep 2026 (requireCollegeWide in routes/teamsAttendance.js and teamsAutomation.js):
  // each one walks every course in the college, whoever presses the button. In the
  // ordinary pass `runToken` IS this suite's own admin token and nothing is created; under
  // SMOKE_SCOPED_DEPARTMENT=1, where every seeded account is narrowed, it is a throwaway
  // college-wide account -- so these assertions keep testing the RUN rather than the new
  // refusal. See lib/college-wide-reader.mjs.
  const runner = await collegeWideReader({ call, token: adminToken, label: "tteams" });
  const runToken = runner.token;
  disposeRunner = runner.dispose;
  if (!adminToken) throw new Error(`admin sign-in failed (HTTP ${adminLogin.status}) — cannot run this suite`);

  // The seeded admin's adminPages is NULL (unconfigured → full access to everything
  // except the explicit-only "mitigations" page — see auth.js's hasPage), which already
  // covers whatever key these routes gate on. Granted explicitly anyway, because a
  // concurrent change is moving /api/teams-attendance/* from requirePage("settings") to
  // requirePage("attendance-settings") — PUT /api/integrations/teams stays on "settings"
  // regardless — and this suite must pass under either key without caring which is live.
  // hasPage's array branch checks literal membership, not ADMIN_PAGES, so granting a key
  // that is not (yet) in that list is harmless. requireAuth re-reads Staff per request
  // (no page list is baked into the token), so this takes effect immediately.
  const priorAdminRow = await db.staff.findUnique({ where: { id: "admin" }, select: { adminPages: true } });
  priorAdminPages = priorAdminRow?.adminPages ?? null;
  await db.staff.update({ where: { id: "admin" }, data: { adminPages: JSON.stringify(["settings", "attendance-settings"]) } });

  course = await db.course.create({ data: { name: `Teams Suite Course ${RUN}` } });
  cohort = await db.cohort.create({ data: { courseId: course.id, name: `Teams Suite Intake ${RUN}` } });

  const mkStudent = (n, email) => db.student.create({ data: {
    firstName: `Teams${n}`, lastName: `Suite${RUN}`, studentRef: `TMS${RUN}${n}`, email,
    initials: `T${n}`, colour: "#1a73e8", cohortId: cohort.id,
  } });
  const s1 = await mkStudent(1, S1_EMAIL); made.students.push(s1.id);
  const s2 = await mkStudent(2, S2_EMAIL); made.students.push(s2.id);
  const s3 = await mkStudent(3, S3_EMAIL); made.students.push(s3.id);

  // No termId: termOpenOn(undefined, date) is `!term || …` — a unit with no term is
  // simply never locked, which keeps this suite's only concern the Teams pipeline
  // itself rather than also having to open and close a Term to stay eligible.
  unit = await db.unit.create({ data: {
    code: `TMS${RUN}`.slice(0, 12), name: `Teams Suite Unit ${RUN}`, courseId: course.id,
    startDate: YEST, endDate: TOM,
  } });
  for (const s of [s1, s2, s3]) {
    const e = await db.enrolment.create({ data: { studentId: s.id, unitId: unit.id } });
    made.enrolments.push(e.id);
  }

  // One TimetableEventGroup per event, all on the same cohort: this unit's enrolment
  // has no Moodle provenance, so deriveRoster's cohort-over-partial-enrolment branch
  // applies regardless — the roster is the cohort, which is all three students either
  // way since all three are both enrolled AND in it.
  const mkEvent = async (title, date, startTime, endTime) => {
    const ev = await db.timetableEvent.create({ data: {
      unitId: unit.id, courseId: course.id, date, startTime, endTime, title, published: true, publishedAt: new Date(),
    } });
    made.events.push(ev.id);
    await db.timetableEventGroup.create({ data: { eventId: ev.id, cohortId: cohort.id } });
    return ev;
  };
  const mkSession = async (event, date, startTime, endTime, description) => {
    const s = await db.hndSession.create({ data: {
      unitId: unit.id, timetableEventId: event.id, cohortId: cohort.id, date, startTime, endTime, description,
    } });
    made.sessions.push(s.id);
    return s;
  };

  const eventA = await mkEvent(`Teams Suite Class ${RUN}`, YEST, T.a.start, T.a.end);
  const sessA = await mkSession(eventA, YEST, T.a.start, T.a.end, `Teams Suite Class ${RUN}`);

  const eventB = await mkEvent(`Teams Suite Tomorrow ${RUN}`, TOM, T.a.start, T.a.end);
  const sessB = await mkSession(eventB, TOM, T.a.start, T.a.end, `Teams Suite Tomorrow ${RUN}`);

  const eventC = await mkEvent(`Teams Suite Failed Fetch ${RUN}`, YEST, T.c.start, T.c.end);
  const sessC = await mkSession(eventC, YEST, T.c.start, T.c.end, `Teams Suite Failed Fetch ${RUN}`);

  // Two DIFFERENT events, same slot, same unhelpful title — the ambiguous case.
  // matchMeeting groups by (date, startTime, timetableEventId), so these are two
  // distinct one-session candidates at one slot, and "Weekly Sync" (the fixture
  // meeting's subject above) is not a substring of "Class" in either direction.
  const eventD = await mkEvent("Class", YEST, T.d.start, T.d.end);
  const sessD = await mkSession(eventD, YEST, T.d.start, T.d.end, "Class");
  const eventE = await mkEvent("Class", YEST, T.d.start, T.d.end);
  const sessE = await mkSession(eventE, YEST, T.d.start, T.d.end, "Class");

  // The pasted-link case, built straight on HndSession rather than through mkEvent —
  // an admin's paste on a TimetableEvent is carried DOWN to teamsJoinUrl by
  // syncEventRegisters (registers.js), so what matters here is the session's own
  // column already being set before the first sync ever runs, not the mechanism that
  // set it. teamsOrganizerId is null (the paste path has no organizer — see
  // teamsSync.js's comment on "the paste path has no organizer"), so collection has
  // to resolve one itself, exactly as it would for a real pasted link.
  const sessF = await db.hndSession.create({ data: {
    unitId: unit.id, date: YEST, startTime: T.f.start, endTime: T.f.end,
    description: "Teams Suite Pasted Link", teamsJoinUrl: URL_F_PASTED, teamsOrganizerId: null,
  } });
  made.sessions.push(sessF.id);

  // Task 10's recurring-meeting scenario: its own unit and cohort, containing ONLY
  // alice and bob, so their roster can never pick up s1/s2/s3 (or vice versa). Both
  // registers carry the SAME teamsJoinUrl and teamsMeetingId — one recurring meeting —
  // pre-set directly on the session exactly as sessF's pasted link is, so this scenario
  // exercises COLLECTION (matching a report to a register by date) rather than
  // discovery, which is already covered above.
  unit2 = await db.unit.create({ data: {
    code: `TMR${RUN}`.slice(0, 12), name: `Teams Suite Recurring Unit ${RUN}`, courseId: course.id,
    startDate: WEEK1, endDate: TOM,
  } });
  cohort2 = await db.cohort.create({ data: { courseId: course.id, name: `Teams Suite Recurring Intake ${RUN}` } });
  const alice = await db.student.create({ data: {
    firstName: "Alice", lastName: `Suite${RUN}`, studentRef: `TMRA${RUN}`, email: ALICE_EMAIL,
    initials: "AL", colour: "#1a73e8", cohortId: cohort2.id,
  } });
  made.students.push(alice.id);
  const bob = await db.student.create({ data: {
    firstName: "Bob", lastName: `Suite${RUN}`, studentRef: `TMRB${RUN}`, email: BOB_EMAIL,
    initials: "BO", colour: "#1a73e8", cohortId: cohort2.id,
  } });
  made.students.push(bob.id);
  for (const s of [alice, bob]) {
    const e = await db.enrolment.create({ data: { studentId: s.id, unitId: unit2.id } });
    made.enrolments.push(e.id);
  }

  const sessWk1 = await db.hndSession.create({ data: {
    unitId: unit2.id, cohortId: cohort2.id, date: WEEK1, startTime: T.g.start, endTime: T.g.end,
    description: "Teams Suite Recurring — week 1", teamsJoinUrl: URL_SERIES, teamsMeetingId: "mtg-series-1", teamsOrganizerId: null,
  } });
  made.sessions.push(sessWk1.id);
  const sessWk2 = await db.hndSession.create({ data: {
    unitId: unit2.id, cohortId: cohort2.id, date: WEEK2, startTime: T.g.start, endTime: T.g.end,
    description: "Teams Suite Recurring — week 2", teamsJoinUrl: URL_SERIES, teamsMeetingId: "mtg-series-1", teamsOrganizerId: null,
  } });
  made.sessions.push(sessWk2.id);

  /* ====================================================================== */
  console.log("\n--- the ship-switched-off proof ---");
  /* ====================================================================== */

  const unconfigured = await call("/teams-attendance/sync", { method: "POST", token: runToken });
  check("a sync is refused before the Teams integration is configured",
    unconfigured.status === 409, `HTTP ${unconfigured.status}`);
  check("...and says so", /not configured/i.test(unconfigured.data?.error || ""), unconfigured.data?.error);

  /* ====================================================================== */
  console.log("\n--- configuring the integration and switching the feature on ---");
  /* ====================================================================== */

  const priorIntegrationRow = await db.tenantIntegration.findFirst({ where: { provider: "teams" } });
  integrationExisted = Boolean(priorIntegrationRow);
  priorIntegration = priorIntegrationRow;

  const priorTeamsConfigRow = await db.teamsAttendanceConfig.findFirst({});
  teamsConfigExisted = Boolean(priorTeamsConfigRow);
  priorTeamsConfig = priorTeamsConfigRow?.settings ?? {};

  // enabled:true here is the TenantIntegration row's own switch, separate from (and a
  // precondition of) TeamsAttendanceConfig.enabled below: integrationConfig.js's
  // stored() treats a saved-but-disabled row as "nothing saved" and falls back to
  // process.env — empty here — so graph.isConfigured() stays false, and every route
  // that gates on it keeps answering 409/false, until this is set.
  const savedIntegration = await call("/integrations/teams", {
    method: "PUT", token: adminToken,
    body: { tenantId: "fake-tenant", clientId: "fake-client", clientSecret: "fake-secret", organizerAccounts: ORG_EMAIL, enabled: true },
  });
  check("an administrator can save Teams credentials",
    savedIntegration.status === 200 && savedIntegration.data?.configured === true, `HTTP ${savedIntegration.status}`);

  // THE WINDOW THIS FIX EXISTS FOR: credentials are saved and Graph now answers
  // isConfigured() === true, but TeamsAttendanceConfig.enabled is still false —
  // exactly the gap TEAMS_SETUP.md's own Step 11 walks an administrator through
  // (save credentials, press Test connection, THEN switch the feature on). Before
  // routes/teamsAttendance.js's `enabled` check existed, POST /sync in this exact
  // window ran a real sync and wrote real marks, because the route only ever asked
  // "is Teams configured", never "is Teams attendance switched on". A regression test
  // for that gap has to run in this window specifically — asserting it only before
  // credentials exist (the check above) or only after the switch is on (implicitly,
  // by every assertion after this) would never re-exercise the branch that was
  // missing, since both of those already answer 409/200 for other reasons.
  const disabledSync = await call("/teams-attendance/sync", { method: "POST", token: runToken });
  check("a sync is refused while configured but still switched off",
    disabledSync.status === 409, `HTTP ${disabledSync.status}`);
  check("...and says so", /switched off/i.test(disabledSync.data?.error || ""), disabledSync.data?.error);

  const enabledSettings = await call("/teams-attendance/settings", { method: "PUT", token: adminToken, body: { enabled: true } });
  check("and switch the sync on", enabledSettings.status === 200 && enabledSettings.data?.settings?.enabled === true,
    `HTTP ${enabledSettings.status} enabled=${enabledSettings.data?.settings?.enabled}`);

  const settingsNow = await call("/teams-attendance/settings", { token: adminToken });
  check("the settings screen now reports the integration as configured",
    settingsNow.data?.configured === true, `configured=${settingsNow.data?.configured}`);

  /* ====================================================================== */
  console.log("\n--- the disagreement case: a lecturer's mark must survive ---");
  /* ====================================================================== */

  const planted = await db.attendanceMark.create({ data: { sessionId: sessA.id, studentId: s1.id, status: "A", remark: "", takenBy: "A. Lecturer" } });
  made.marks.push(planted.id);

  /* ====================================================================== */
  console.log("\n--- the sync itself ---");
  /* ====================================================================== */

  // Captured before this suite's first sync, so cleanup can scope its TeamsSync
  // deletion to runs THIS suite created rather than every row in the table — a
  // courtesy to anything else that might ever write one during this DATABASE_URL's
  // lifetime, even though nothing else does today.
  runStart = new Date();
  const synced = await call("/teams-attendance/sync", { method: "POST", token: runToken });
  check("the sync runs and answers 200", synced.status === 200, `HTTP ${synced.status} ${synced.data?.error || ""}`);

  const s1Mark = await db.attendanceMark.findFirst({ where: { sessionId: sessA.id, studentId: s1.id } });
  check("THE NEVER-OVERWRITE INVARIANT: student1's mark is still the lecturer's A",
    s1Mark?.status === "A" && s1Mark?.takenBy === "A. Lecturer", `status=${s1Mark?.status} takenBy=${s1Mark?.takenBy}`);

  const s2Mark = await db.attendanceMark.findFirst({ where: { sessionId: sessA.id, studentId: s2.id } });
  check("student2 (joined 09:27, past the 09:22 late cutoff) is marked L by the sync",
    s2Mark?.status === "L" && s2Mark?.takenBy === "Auto check-in (Teams)" && s2Mark?.checkedInAt === "09:27",
    `status=${s2Mark?.status} takenBy=${s2Mark?.takenBy} checkedInAt=${s2Mark?.checkedInAt}`);

  const s3Mark = await db.attendanceMark.findFirst({ where: { sessionId: sessA.id, studentId: s3.id } });
  check("student3 (rostered, report fetched, never joined) is marked A by the sync",
    s3Mark?.status === "A" && s3Mark?.takenBy === "Auto check-in (Teams)", `status=${s3Mark?.status} takenBy=${s3Mark?.takenBy}`);

  const tomorrowMarks = await db.attendanceMark.count({ where: { sessionId: sessB.id } });
  check("tomorrow's register has zero marks — a matched future session is never touched", tomorrowMarks === 0, `${tomorrowMarks} mark(s)`);

  // READ WITH runToken, because the assertions below are about the run's ISSUE LIST. A
  // run's issues are free text naming students from every course it touched, so since
  // 28 Sep 2026 the history endpoint withholds them from a narrowed caller and sets
  // issuesWithheld — which in the scoped pass left these assertions reading [] and calling
  // it a missing issue. The run is college-wide; so is the account that reads its report.
  const runsAfterFirst = await call("/teams-attendance/runs", { token: runToken });
  const latestRun = runsAfterFirst.data?.runs?.[0];
  check("the run row reports exactly one unmatched participant",
    latestRun?.summary?.participantsUnmatched === 1, `participantsUnmatched=${latestRun?.summary?.participantsUnmatched}`);
  check("...and names the stranger rather than guessing them onto a register",
    (latestRun?.issues || []).some((i) => i.includes(STRANGER_EMAIL)), JSON.stringify(latestRun?.issues));

  const s1Tap = await db.tagTap.findFirst({ where: { sessionId: sessA.id, studentId: s1.id, method: "teams" } });
  check("student1's log row is already_marked, carrying no status of its own",
    s1Tap?.outcome === "already_marked" && s1Tap?.status == null, `outcome=${s1Tap?.outcome} status=${s1Tap?.status}`);
  const s1TapMarked = await db.tagTap.findFirst({ where: { sessionId: sessA.id, studentId: s1.id, method: "teams", outcome: "marked" } });
  check("...and NEVER a 'marked' row — the sync did not write that mark", !s1TapMarked, s1TapMarked ? "found one" : "");

  const writtenTaps = await db.tagTap.findMany({ where: { sessionId: sessA.id, studentId: { in: [s2.id, s3.id] }, method: "teams", outcome: "marked" } });
  check("both written marks (student2, student3) have their own 'marked' log rows",
    writtenTaps.length === 2, `${writtenTaps.length} of 2`);

  const sessAAfter = await db.hndSession.findUnique({ where: { id: sessA.id } });
  check("yesterday's session now carries the resolved meeting id and a collection timestamp",
    sessAAfter?.teamsMeetingId === "m-a" && sessAAfter?.teamsCollectedAt != null,
    `teamsMeetingId=${sessAAfter?.teamsMeetingId} teamsCollectedAt=${sessAAfter?.teamsCollectedAt}`);

  /* ====================================================================== */
  console.log("\n--- the failed-fetch case: absent is only written on a successful fetch ---");
  /* ====================================================================== */

  const sessCMarks = await db.attendanceMark.count({ where: { sessionId: sessC.id } });
  check("the session whose report could not be fetched has NO marks", sessCMarks === 0, `${sessCMarks} mark(s)`);
  const sessCAfter = await db.hndSession.findUnique({ where: { id: sessC.id } });
  check("...and no teamsCollectedAt, so the retry window still applies to it", sessCAfter?.teamsCollectedAt == null,
    `teamsCollectedAt=${sessCAfter?.teamsCollectedAt}`);
  check("the run lists the fetch failure as an issue",
    (latestRun?.issues || []).some((i) => i.includes("could not be fetched")), JSON.stringify(latestRun?.issues));

  /* ====================================================================== */
  console.log("\n--- the ambiguous case: two classes, one slot, no guess ---");
  /* ====================================================================== */

  const sessDAfter = await db.hndSession.findUnique({ where: { id: sessD.id } });
  const sessEAfter = await db.hndSession.findUnique({ where: { id: sessE.id } });
  check("neither ambiguous register received a join url",
    sessDAfter?.teamsJoinUrl == null && sessEAfter?.teamsJoinUrl == null,
    `D=${sessDAfter?.teamsJoinUrl} E=${sessEAfter?.teamsJoinUrl}`);
  check("the run's issues name the collision",
    (latestRun?.issues || []).some((i) => i.includes("matches more than one class")), JSON.stringify(latestRun?.issues));

  /* ====================================================================== */
  console.log("\n--- the pasted-link case: an admin's paste beats the matcher ---");
  /* ====================================================================== */

  const sessFAfter = await db.hndSession.findUnique({ where: { id: sessF.id } });
  check("the pasted url survives discovery untouched, even with a competing meeting at the same slot",
    sessFAfter?.teamsJoinUrl === URL_F_PASTED, `teamsJoinUrl=${sessFAfter?.teamsJoinUrl}`);
  check("...and its meeting id resolved from the PASTED url, not the competing one",
    sessFAfter?.teamsMeetingId === "m-f", `teamsMeetingId=${sessFAfter?.teamsMeetingId}`);

  const s1PastedMark = await db.attendanceMark.findFirst({ where: { sessionId: sessF.id, studentId: s1.id } });
  check("the mark was written from the pasted meeting's own report",
    s1PastedMark?.status === "P" && s1PastedMark?.takenBy === "Auto check-in (Teams)",
    `status=${s1PastedMark?.status} takenBy=${s1PastedMark?.takenBy}`);

  /* ====================================================================== */
  console.log("\n--- the recurring-meeting case: per-week separation, no cross-contamination ---");
  /* ====================================================================== */
  // THE BUG THIS PINS: one join URL, one resolved meeting id, TWO registers on two
  // dates. Before attendanceByOccurrence carried a date per occurrence, collection read
  // one flat participants list per meeting id — so a student present in EITHER week's
  // report would have been marked Present on BOTH registers, because nothing on the
  // fixture or the collector's read of it distinguished which week was which. alice
  // attended week 1 only; bob attended week 2 only. If the two occurrences' intervals
  // were ever merged before being matched to a register by date, both would show BOTH
  // students Present on BOTH weeks — which is exactly what the four checks below rule out.

  const week1AliceMark = await db.attendanceMark.findFirst({ where: { sessionId: sessWk1.id, studentId: alice.id } });
  check("week 1's register marks alice Present, from week 1's own occurrence",
    week1AliceMark?.status === "P" && week1AliceMark?.takenBy === "Auto check-in (Teams)",
    `status=${week1AliceMark?.status} takenBy=${week1AliceMark?.takenBy}`);
  const week1BobMark = await db.attendanceMark.findFirst({ where: { sessionId: sessWk1.id, studentId: bob.id } });
  check("...and bob is NOT present on week 1 — he is only in week 2's occurrence",
    week1BobMark?.status !== "P", `status=${week1BobMark?.status}`);

  const week2BobMark = await db.attendanceMark.findFirst({ where: { sessionId: sessWk2.id, studentId: bob.id } });
  check("week 2's register marks bob Present, from week 2's own occurrence",
    week2BobMark?.status === "P" && week2BobMark?.takenBy === "Auto check-in (Teams)",
    `status=${week2BobMark?.status} takenBy=${week2BobMark?.takenBy}`);
  const week2AliceMark = await db.attendanceMark.findFirst({ where: { sessionId: sessWk2.id, studentId: alice.id } });
  check("...and alice is NOT present on week 2 — the shared meeting id did not merge the weeks",
    week2AliceMark?.status !== "P", `status=${week2AliceMark?.status}`);

  /* ====================================================================== */
  console.log("\n--- discovery ignores a meeting that matches no timetabled slot ---");
  /* ====================================================================== */

  check("the personal meeting produced no issue and matched nothing",
    !(latestRun?.issues || []).some((i) => i.includes("Personal 1:1")), JSON.stringify(latestRun?.issues));

  /* ====================================================================== */
  console.log("\n--- idempotence: a second sync writes nothing new ---");
  /* ====================================================================== */

  const secondSync = await call("/teams-attendance/sync", { method: "POST", token: runToken });
  check("a second sync still answers 200", secondSync.status === 200, `HTTP ${secondSync.status}`);
  check("...and creates no new marks — the collected session is not revisited",
    secondSync.data?.summary?.marksCreated === 0, `marksCreated=${secondSync.data?.summary?.marksCreated}`);

  const sessAMarkCount = await db.attendanceMark.count({ where: { sessionId: sessA.id } });
  check("session A still holds exactly three marks after the second sync", sessAMarkCount === 3, `${sessAMarkCount} mark(s)`);
  const sessATapCount = await db.tagTap.count({ where: { sessionId: sessA.id, method: "teams" } });
  check("...and exactly three Teams log rows, not six", sessATapCount === 3, `${sessATapCount} row(s)`);

  /* ====================================================================== */
  console.log("\n--- the settings contract, over HTTP and through the database ---");
  /* ====================================================================== */

  // teamsAttendanceSettings.merge is unit-tested, but the contract that matters to a
  // college is the one the route and the config table implement together: a PATCH falls
  // back to WHAT THIS COLLEGE ALREADY HAD, not to the platform default. Proving that at
  // the merge() level leaves the possibility that the route passes DEFAULTS as the base,
  // which would answer 200 OK while quietly resetting a threshold somebody tuned.
  const setTo75 = await call("/teams-attendance/settings", { method: "PUT", token: adminToken, body: { minAttendancePct: 75 } });
  check("an administrator can set the threshold to 75%",
    setTo75.status === 200 && setTo75.data?.settings?.minAttendancePct === 75,
    `HTTP ${setTo75.status} pct=${setTo75.data?.settings?.minAttendancePct}`);

  const badPatch = await call("/teams-attendance/settings", { method: "PUT", token: adminToken, body: { minAttendancePct: "half" } });
  check("THE PATCH CONTRACT: an unusable threshold leaves the college's own 75 standing",
    badPatch.data?.settings?.minAttendancePct === 75,
    `pct=${badPatch.data?.settings?.minAttendancePct} (50 would mean it reset to the platform default)`);
  check("...and the switch beside it was not disturbed either",
    badPatch.data?.settings?.enabled === true, `enabled=${badPatch.data?.settings?.enabled}`);

  const storedAfterBad = await db.teamsAttendanceConfig.findFirst({});
  const storedPct = (storedAfterBad?.settings ?? {}).minAttendancePct;
  check("...and the DATABASE agrees — the bad value was never written",
    storedPct === 75, `stored=${JSON.stringify(storedPct)}`);

  // The clamp, through the route rather than the pure function. 0% is the dangerous end:
  // a report row showing one second of a two-hour lecture clears "more than 0%", so an
  // unclamped zero would mark every ghost row Present.
  const zeroPct = await call("/teams-attendance/settings", { method: "PUT", token: adminToken, body: { minAttendancePct: 0 } });
  check("a threshold of 0% is clamped up to 1, never stored as 0",
    zeroPct.data?.settings?.minAttendancePct === 1, `pct=${zeroPct.data?.settings?.minAttendancePct}`);
  const overPct = await call("/teams-attendance/settings", { method: "PUT", token: adminToken, body: { minAttendancePct: 250 } });
  check("a threshold above 100% is clamped down to 100",
    overPct.data?.settings?.minAttendancePct === 100, `pct=${overPct.data?.settings?.minAttendancePct}`);

  const unknownKey = await call("/teams-attendance/settings", { method: "PUT", token: adminToken, body: { somethingNew: true, minAttendancePct: 60 } });
  check("an unknown key is dropped by the allowlist rather than stored",
    unknownKey.data?.settings?.somethingNew === undefined && unknownKey.data?.settings?.minAttendancePct === 60,
    JSON.stringify(unknownKey.data?.settings));

  /* ====================================================================== */
  console.log("\n--- the switch closes again, not just opens ---");
  /* ====================================================================== */

  // The existing ship-switched-off proof near the top runs BEFORE the feature was ever
  // enabled. This is the other direction: a college that turned Teams attendance on and
  // then thought better of it. The same 409 must come back, from a process whose caches
  // are already warm and whose credentials are still perfectly valid — which is exactly
  // the state in which a stale cached `enabled: true` would go unnoticed.
  const switchOff = await call("/teams-attendance/settings", { method: "PUT", token: adminToken, body: { enabled: false } });
  check("the feature can be switched back off", switchOff.data?.settings?.enabled === false,
    `enabled=${switchOff.data?.settings?.enabled}`);

  const syncAfterOff = await call("/teams-attendance/sync", { method: "POST", token: runToken });
  check("OFF MEANS NOTHING RUNS, even after it ran today: the sync is refused again",
    syncAfterOff.status === 409, `HTTP ${syncAfterOff.status}`);
  check("...and says it is switched off, not that it is unconfigured",
    /switched off/i.test(syncAfterOff.data?.error || ""), syncAfterOff.data?.error);

  const runsAfterOff = await db.teamsSync.count();
  const syncAgain = await call("/teams-attendance/sync", { method: "POST", token: runToken });
  check("...and a refused sync writes no run row at all",
    syncAgain.status === 409 && (await db.teamsSync.count()) === runsAfterOff,
    `HTTP ${syncAgain.status}, rows ${runsAfterOff} -> ${await db.teamsSync.count()}`);

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
