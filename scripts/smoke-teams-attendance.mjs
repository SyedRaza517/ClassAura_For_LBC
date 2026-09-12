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
//     writes nothing new, which is what makes an hourly poller safe to run at all.
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

// A valid-shaped join link is all parseJoinUrl asks for (see teamsAttendance.js); the
// suffix only needs to be unique per meeting.
const joinUrl = (n) => `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${RUN}_${n}%40thread.v2/0`;
const URL_A = joinUrl("a"); // yesterday 09:07 — the happy path
const URL_B = joinUrl("b"); // tomorrow — matched, never collected
const URL_C = joinUrl("c"); // yesterday 11:19 — the failed-fetch case
const URL_D = joinUrl("d"); // yesterday 13:31 — the ambiguous slot
const URL_E = joinUrl("e"); // a personal meeting at a time nothing is timetabled

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
};

const made = { sessions: [], events: [], enrolments: [], marks: [], students: [] };
let unit = null, cohort = null, course = null;
let child = null, bootLog = "";
let integrationExisted = false, priorIntegration = null;
let teamsConfigExisted = false, priorTeamsConfig = null;
let priorAdminPages;

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

async function cleanup() {
  try {
    await db.tagTap.deleteMany({ where: { sessionId: { in: made.sessions } } }).catch(() => {});
    for (const id of made.marks) await db.attendanceMark.delete({ where: { id } }).catch(() => {});
    for (const id of made.sessions) await db.hndSession.delete({ where: { id } }).catch(() => {});
    for (const id of made.events) await db.timetableEvent.delete({ where: { id } }).catch(() => {}); // groups cascade
    for (const id of made.enrolments) await db.enrolment.delete({ where: { id } }).catch(() => {});
    if (unit) await db.unit.delete({ where: { id: unit.id } }).catch(() => {});
    for (const id of made.students) await db.student.delete({ where: { id } }).catch(() => {});
    if (cohort) await db.cohort.delete({ where: { id: cohort.id } }).catch(() => {});
    if (course) await db.course.delete({ where: { id: course.id } }).catch(() => {});

    // This suite's own runs, only. Nothing else in an isolated DATABASE_URL writes
    // TeamsSync rows during this suite's lifetime — the shared API on port 4010 (if
    // running at all) never sees TEAMS_GRAPH_FIXTURES and never gets asked to sync.
    await db.teamsSync.deleteMany({}).catch(() => {});

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
      ],
    },
    meetingIds: { [URL_A]: "m-a", [URL_C]: "m-c", [URL_B]: "m-b" },
    attendance: {
      "m-a": [
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
      ],
      // "m-c" IS DELIBERATELY ABSENT. teamsGraph.js's fixture branch now throws for a
      // meeting id with no key here (Task 10's one-line change to teamsGraph.js) rather
      // than answering [] — a fetch that failed must not read like a report that
      // succeeded and found nobody.
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

  /* ====================================================================== */
  console.log("\n--- the ship-switched-off proof ---");
  /* ====================================================================== */

  const unconfigured = await call("/teams-attendance/sync", { method: "POST", token: adminToken });
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

  const synced = await call("/teams-attendance/sync", { method: "POST", token: adminToken });
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

  const runsAfterFirst = await call("/teams-attendance/runs", { token: adminToken });
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
  console.log("\n--- discovery ignores a meeting that matches no timetabled slot ---");
  /* ====================================================================== */

  check("the personal meeting produced no issue and matched nothing",
    !(latestRun?.issues || []).some((i) => i.includes("Personal 1:1")), JSON.stringify(latestRun?.issues));

  /* ====================================================================== */
  console.log("\n--- idempotence: a second sync writes nothing new ---");
  /* ====================================================================== */

  const secondSync = await call("/teams-attendance/sync", { method: "POST", token: adminToken });
  check("a second sync still answers 200", secondSync.status === 200, `HTTP ${secondSync.status}`);
  check("...and creates no new marks — the collected session is not revisited",
    secondSync.data?.summary?.marksCreated === 0, `marksCreated=${secondSync.data?.summary?.marksCreated}`);

  const sessAMarkCount = await db.attendanceMark.count({ where: { sessionId: sessA.id } });
  check("session A still holds exactly three marks after the second sync", sessAMarkCount === 3, `${sessAMarkCount} mark(s)`);
  const sessATapCount = await db.tagTap.count({ where: { sessionId: sessA.id, method: "teams" } });
  check("...and exactly three Teams log rows, not six", sessATapCount === 3, `${sessATapCount} row(s)`);

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
