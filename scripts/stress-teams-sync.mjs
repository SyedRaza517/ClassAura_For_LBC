// Teams automated ingestion under LOAD — the half of attendance that had no stress
// coverage at all.
//
// stress-qr.mjs hammers the student-facing write, where load means "a lecture hall of
// phones at 09:15". The Teams collector's load is a different shape entirely: nobody is
// waiting on an HTTP response, and the pressure is the SIZE of one run. A college with
// forty online classes a day and fifty students in each is asking one request to decide
// and write two thousand attendance marks, each of which is a permanent record somebody
// may have to defend at a funding audit.
//
// What this script is for, specifically:
//
//   T1  COLD      N sessions x M students, first collection  -> every mark written once,
//                 and how long two thousand decisions actually take
//   T2  RECOLLECT the same registers collected AGAIN (the state a run killed before
//                 teamsCollectedAt leaves behind)            -> ZERO new marks, and the
//                 tap log says "already_marked", never a second "marked"
//   T3  SERIES    one recurring meeting id shared by K weekly registers -> each week
//                 gets ITS OWN week's participants, at scale, never the union
//   T4  STRANGERS one report carrying far more participants than the roster -> unmatched
//                 are reported rather than guessed, and the run's `issues` list is
//                 measured, because it grows one entry per stranger
//
// T2 is the one that pays for this script twice over. The authorship fix in
// teamsSync.js reads the standing marks BEFORE createMany so a second Teams run cannot
// log a student as newly "marked" twice — correct, and it adds one query per session.
// This measures what that costs when there are forty of them and nothing to write,
// which is the case nobody would notice getting slower.
//
// THE GRAPH SEAM. Everything Microsoft would answer comes from TEAMS_GRAPH_FIXTURES, a
// JSON file this script writes and the API reads fresh on every call. That means this
// script stresses the ENGINE — roster matching, the decision per student, createMany,
// the tap log, the collectedAt stamp — and deliberately not the HTTP transport, which
// has no fixture and cannot be driven from here. Pagination, 429s and token expiry are
// covered as unit tests against a stubbed fetch instead (teamsSync.audit.test.js).
//
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/edtech_stress_test \
//     SEED_PASSWORD=... node scripts/stress-teams-sync.mjs
//
//   STRESS_SESSIONS=40 STRESS_STUDENTS=50   # the scale, both overridable
//
// Run against a THROWAWAY database only. It creates a cohort, collects attendance over
// it, and removes everything it made — but it writes thousands of rows to do so.
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const server = join(ROOT, "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);
const bcrypt = require(`${ROOT}/server/node_modules/bcryptjs`);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — a THROWAWAY database.");
  process.exit(1);
}

// The same refusal the test runner and the seed apply, for the same reason: this script
// writes thousands of rows and deletes them again, and server/.env has pointed at a live
// database. Asked BEFORE the API is booted or a single row is created.
require(join(server, "prisma", "assertDisposable.js"))
  .assertDisposable("stress-teams-sync.mjs creates a cohort and collects attendance over it");

const SESSIONS = Number(process.env.STRESS_SESSIONS) || 40;
const STUDENTS = Number(process.env.STRESS_STUDENTS) || 50;
// teamsSync only looks back RETRY_DAYS (7) days, so a series longer than that has weeks
// the collector is RIGHT to ignore. Six keeps every week of T3 inside the window; T5
// tests the boundary itself with a register deliberately placed outside it. The first
// draft of this script used eight and read the two correct refusals as failures.
const RETRY_DAYS = 7;
const WEEKS = Math.min(Number(process.env.STRESS_WEEKS) || 6, RETRY_DAYS - 1);
const STRANGERS = Number(process.env.STRESS_STRANGERS) || 450; // T4

const PORT = Number(process.env.STRESS_TEAMS_PORT) || 4031;
const BASE = `http://localhost:${PORT}/api`;
const RUN = `${Date.now()}`;
const FIXTURES_PATH = join(tmpdir(), `teams-stress-fixtures-${RUN}.json`);
const JWT_SECRET = process.env.JWT_SECRET || "test-secret-not-for-production";
const CREDENTIALS_KEY = process.env.CREDENTIALS_KEY
  || "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const SEED_PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";

const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

let passed = 0, failed = 0;
const ok = (l, d) => { passed++; console.log(`✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, e) => { failed++; console.log(`✗ ${l}\n    ${e && e.message ? e.message : e}`); };
const check = async (l, fn) => { try { ok(l, await fn()); } catch (e) { bad(l, e); } };
const call = async (path, { method = "GET", body, token } = {}) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ms = (t0) => Math.round(performance.now() - t0);
const rate = (n, t) => (t <= 0 ? "n/a" : `${Math.round((n / t) * 1000)}/s`);

const ZONE = process.env.APP_TIMEZONE || "Europe/London";
const dayOffset = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: ZONE });
};
const YESTERDAY = dayOffset(-1);

// ---------------------------------------------------------------------------- fixtures
const ORG_EMAIL = "teams.organizer@edtech.co.uk";
const ORG_ID = "org-stress-1";
const stamp = RUN;
const made = { students: [], units: [], sessions: [] };
let child = null, integrationExisted = false, priorIntegration = null, priorTeamsConfig = null, teamsConfigExisted = false;

const stopApi = () => {
  if (child && !child.killed) {
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", child.pid, "/f", "/t"]);
      else child.kill("SIGTERM");
    } catch { /* already gone */ }
  }
};

async function cleanup() {
  stopApi();
  try { unlinkSync(FIXTURES_PATH); } catch { /* never written */ }
  // Order matters: marks and taps reference sessions and students.
  if (made.sessions.length) {
    await db.attendanceMark.deleteMany({ where: { sessionId: { in: made.sessions } } }).catch(() => {});
    await db.tagTap.deleteMany({ where: { sessionId: { in: made.sessions } } }).catch(() => {});
    await db.hndSession.deleteMany({ where: { id: { in: made.sessions } } }).catch(() => {});
  }
  if (made.students.length) {
    await db.tagTap.deleteMany({ where: { studentId: { in: made.students } } }).catch(() => {});
    await db.enrolment.deleteMany({ where: { studentId: { in: made.students } } }).catch(() => {});
    await db.student.deleteMany({ where: { id: { in: made.students } } }).catch(() => {});
  }
  if (made.units.length) await db.unit.deleteMany({ where: { id: { in: made.units } } }).catch(() => {});
  await db.teamsSync.deleteMany({ where: { startedAt: { gte: new Date(Number(RUN) - 1000) } } }).catch(() => {});
  // Put the integration and the feature switch back exactly as found. A college's real
  // credentials must not be left replaced by "fake-tenant", and a feature left switched
  // ON by a stress run is a feature that starts syncing on the next scheduler tick.
  if (integrationExisted && priorIntegration) {
    await db.tenantIntegration.updateMany({ where: { provider: "teams" }, data: priorIntegration }).catch(() => {});
  } else {
    await db.tenantIntegration.deleteMany({ where: { provider: "teams" } }).catch(() => {});
  }
  if (teamsConfigExisted && priorTeamsConfig) {
    await db.teamsAttendanceConfig.updateMany({ data: { settings: priorTeamsConfig } }).catch(() => {});
  } else {
    await db.teamsAttendanceConfig.deleteMany({}).catch(() => {});
  }
  await db.$disconnect();
}

process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

console.log(`\n=== Teams ingestion stress ===`);
console.log(`scale: ${SESSIONS} sessions x ${STUDENTS} students = ${SESSIONS * STUDENTS} marks` +
  ` · series ${WEEKS} weeks · ${STRANGERS} strangers\n`);

try {
  // ------------------------------------------------------------------- the cohort
  console.log(`creating ${STUDENTS} students…`);
  const pwHash = bcrypt.hashSync("StressPass123!", 8);
  const students = [];
  for (let i = 0; i < STUDENTS; i++) {
    const email = `ts.${stamp}.${i}@edtech.co.uk`;
    const s = await db.student.create({ data: {
      firstName: "TeamsStress", lastName: `S${String(i).padStart(3, "0")}`,
      studentRef: `ZZTS${stamp}${i}`.slice(0, 20),
      email, initials: "TS", colour: "#1a3a8f", passwordHash: pwHash,
    } });
    students.push({ id: s.id, email, msUserId: `ms-${stamp}-${i}` });
    made.students.push(s.id);
  }

  console.log(`creating ${SESSIONS} units and registers…`);
  const meetingIds = {};
  const attendanceByOccurrence = {};
  const plainSessions = [];
  for (let i = 0; i < SESSIONS; i++) {
    const unit = await db.unit.create({ data: {
      code: `ZZTS-${stamp}-${i}`, name: `Teams Stress Unit ${i}`, unitNumber: "", tutor: "",
    } });
    made.units.push(unit.id);
    for (const s of students) await db.enrolment.create({ data: { unitId: unit.id, studentId: s.id } });

    const joinUrl = `https://teams.microsoft.com/l/meetup-join/stress-${stamp}-${i}`;
    const meetingId = `m-stress-${i}`;
    meetingIds[joinUrl] = meetingId;
    // Every student attended the whole hour, so every decision is the same work and the
    // timing is not distorted by a cheap "never joined" shortcut for half the cohort.
    attendanceByOccurrence[meetingId] = [{
      date: YESTERDAY,
      intervals: students.map((s) => ({
        email: s.email, msUserId: s.msUserId,
        intervals: [{ joinedAt: "09:00", leftAt: "10:00" }],
      })),
    }];
    const sess = await db.hndSession.create({ data: {
      unitId: unit.id, date: YESTERDAY, startTime: "09:00", endTime: "10:00",
      description: `teams stress ${i}`, teamsJoinUrl: joinUrl,
    } });
    made.sessions.push(sess.id);
    plainSessions.push(sess.id);
  }

  // T3: ONE meeting id, WEEKS registers on different dates. Each week's report names a
  // different single student, so a collector that flattened the occurrences into one set
  // would credit every student to every week and this block would notice.
  const seriesUnit = await db.unit.create({ data: {
    code: `ZZTSR-${stamp}`, name: "Teams Stress Series", unitNumber: "", tutor: "",
  } });
  made.units.push(seriesUnit.id);
  for (const s of students) await db.enrolment.create({ data: { unitId: seriesUnit.id, studentId: s.id } });
  const seriesUrl = `https://teams.microsoft.com/l/meetup-join/stress-series-${stamp}`;
  const seriesMeeting = "m-stress-series";
  meetingIds[seriesUrl] = seriesMeeting;
  const seriesSessions = [];
  const seriesOccurrences = [];
  for (let w = 0; w < WEEKS; w++) {
    const date = dayOffset(-1 - w);
    const owner = students[w % students.length];
    seriesOccurrences.push({
      date,
      intervals: [{ email: owner.email, msUserId: owner.msUserId, intervals: [{ joinedAt: "11:00", leftAt: "12:00" }] }],
    });
    const sess = await db.hndSession.create({ data: {
      unitId: seriesUnit.id, date, startTime: "11:00", endTime: "12:00",
      description: `teams stress series w${w}`, teamsJoinUrl: seriesUrl,
    } });
    made.sessions.push(sess.id);
    seriesSessions.push({ id: sess.id, date, ownerId: owner.id });
  }
  attendanceByOccurrence[seriesMeeting] = seriesOccurrences;

  // T4: a report carrying far more people than the roster. The strangers are the load:
  // each one is a lookup miss, a counter increment and an `issues` entry.
  const strangerUnit = await db.unit.create({ data: {
    code: `ZZTSX-${stamp}`, name: "Teams Stress Strangers", unitNumber: "", tutor: "",
  } });
  made.units.push(strangerUnit.id);
  for (const s of students) await db.enrolment.create({ data: { unitId: strangerUnit.id, studentId: s.id } });
  const strangerUrl = `https://teams.microsoft.com/l/meetup-join/stress-strangers-${stamp}`;
  const strangerMeeting = "m-stress-strangers";
  meetingIds[strangerUrl] = strangerMeeting;
  attendanceByOccurrence[strangerMeeting] = [{
    date: YESTERDAY,
    intervals: [
      ...students.map((s) => ({ email: s.email, msUserId: s.msUserId, intervals: [{ joinedAt: "14:00", leftAt: "15:00" }] })),
      ...Array.from({ length: STRANGERS }, (_, k) => ({
        email: `stranger.${k}@elsewhere.example`, msUserId: null,
        intervals: [{ joinedAt: "14:05", leftAt: "14:40" }],
      })),
    ],
  }];
  const strangerSession = await db.hndSession.create({ data: {
    unitId: strangerUnit.id, date: YESTERDAY, startTime: "14:00", endTime: "15:00",
    description: "teams stress strangers", teamsJoinUrl: strangerUrl,
  } });
  made.sessions.push(strangerSession.id);

  // T5: one register older than RETRY_DAYS, carrying a PERFECTLY GOOD report. The report
  // matters: without it the "no marks" assertion would pass because Graph had nothing to
  // say, not because the window held, and would keep passing if the window were removed.
  const staleUnit = await db.unit.create({ data: {
    code: `ZZTSO-${stamp}`, name: "Teams Stress Too Old", unitNumber: "", tutor: "",
  } });
  made.units.push(staleUnit.id);
  for (const s of students) await db.enrolment.create({ data: { unitId: staleUnit.id, studentId: s.id } });
  const staleUrl = `https://teams.microsoft.com/l/meetup-join/stress-stale-${stamp}`;
  const staleMeeting = "m-stress-stale";
  const STALE_DATE = dayOffset(-(RETRY_DAYS + 1));
  meetingIds[staleUrl] = staleMeeting;
  attendanceByOccurrence[staleMeeting] = [{
    date: STALE_DATE,
    intervals: students.map((s) => ({
      email: s.email, msUserId: s.msUserId, intervals: [{ joinedAt: "09:00", leftAt: "10:00" }],
    })),
  }];
  const staleSession = await db.hndSession.create({ data: {
    unitId: staleUnit.id, date: STALE_DATE, startTime: "09:00", endTime: "10:00",
    description: "teams stress too old", teamsJoinUrl: staleUrl,
  } });
  made.sessions.push(staleSession.id);

  writeFileSync(FIXTURES_PATH, JSON.stringify({
    organizers: [{ email: ORG_EMAIL, id: ORG_ID }],
    users: { [ORG_EMAIL.toLowerCase()]: ORG_ID },
    calendars: { [ORG_ID]: [] }, // discovery has nothing to find: join urls are preset
    meetingIds,
    attendanceByOccurrence,
  }, null, 2));

  // ------------------------------------------------------------------- the API
  console.log(`→ starting a private API on port ${PORT} (TEAMS_GRAPH_FIXTURES set)`);
  child = spawn("node", ["src/index.js"], {
    cwd: server, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(PORT), NODE_ENV: "test", JWT_SECRET, CREDENTIALS_KEY,
      ATTENDANCE_TAP_CACHE_MS: "0",
      TEAMS_GRAPH_FIXTURES: FIXTURES_PATH,
    },
  });
  let apiLog = "";
  child.stdout.on("data", (d) => { apiLog += d.toString(); });
  child.stderr.on("data", (d) => { apiLog += d.toString(); });

  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { healthy = (await fetch(`${BASE}/health`)).ok; } catch { /* not up yet */ }
  }
  if (!healthy) {
    console.error("the private API never became healthy:\n" + apiLog.slice(-2000));
    await cleanup();
    process.exit(2);
  }

  const login = await call("/auth/login", { method: "POST", body: { email: "admin@edtech.co.uk", password: SEED_PASSWORD } });
  const adminToken = login.body.token;
  assert.ok(adminToken, `admin must sign in (HTTP ${login.status})`);

  // Remember what was there, then configure. Restored in cleanup().
  const priorIntegrationRow = await db.tenantIntegration.findFirst({ where: { provider: "teams" } });
  integrationExisted = Boolean(priorIntegrationRow);
  if (priorIntegrationRow) {
    priorIntegration = {
      settings: priorIntegrationRow.settings, secretEnc: priorIntegrationRow.secretEnc,
      enabled: priorIntegrationRow.enabled,
    };
  }
  const priorTeamsConfigRow = await db.teamsAttendanceConfig.findFirst({});
  teamsConfigExisted = Boolean(priorTeamsConfigRow);
  priorTeamsConfig = priorTeamsConfigRow?.settings ?? null;

  const cfg = await call("/integrations/teams", { method: "PUT", token: adminToken, body: {
    tenantId: "fake-tenant", clientId: "fake-client", clientSecret: "fake-secret",
    organizerAccounts: ORG_EMAIL, enabled: true,
  } });
  assert.ok(cfg.status === 200, `the integration must save (HTTP ${cfg.status})`);
  const on = await call("/teams-attendance/settings", { method: "PUT", token: adminToken, body: { enabled: true } });
  assert.equal(on.body?.settings?.enabled, true, "the sync must be switched on");

  const sync = () => call("/teams-attendance/sync", { method: "POST", token: adminToken });
  const totalExpected = SESSIONS * STUDENTS;

  console.log("");

  /* ------------------------------------------------------------------ T1 COLD */
  await check(`T1 COLD: ${SESSIONS} registers x ${STUDENTS} students collected in one run`, async () => {
    const t0 = performance.now();
    const r = await sync();
    const took = ms(t0);
    assert.equal(r.status, 200, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    const s = r.body.summary || r.body.run?.summary || r.body;
    const created = Number(s.marksCreated ?? -1);
    // Every rostered student gets a mark on every COLLECTED register, present or not:
    // the plain registers, plus one per week of the series, plus the strangers' register.
    // The too-old register contributes nothing, which T5 asserts separately.
    const expected = totalExpected + (WEEKS * STUDENTS) + STUDENTS;
    assert.equal(created, expected, `marksCreated=${created}, expected ${expected}`);
    const inDb = await db.attendanceMark.count({ where: { sessionId: { in: made.sessions } } });
    assert.equal(inDb, expected, `the database holds ${inDb}, not ${expected}`);
    return `${created} marks in ${took}ms (${rate(created, took)}) · reportsFetched=${s.reportsFetched}`;
  });

  await check("T1: every rostered student has EXACTLY one mark per register, none doubled", async () => {
    const grouped = await db.attendanceMark.groupBy({
      by: ["sessionId", "studentId"], where: { sessionId: { in: plainSessions } }, _count: { _all: true },
    });
    const doubled = grouped.filter((g) => g._count._all !== 1);
    assert.equal(doubled.length, 0, `${doubled.length} (sessionId, studentId) pairs hold more than one mark`);
    assert.equal(grouped.length, totalExpected, `${grouped.length} pairs, expected ${totalExpected}`);
    return `${grouped.length} pairs, every one holding exactly 1 mark`;
  });

  await check("T1: a full hour of a one-hour class is Present, at every scale", async () => {
    const byStatus = await db.attendanceMark.groupBy({
      by: ["status"], where: { sessionId: { in: plainSessions } }, _count: { _all: true },
    });
    const map = Object.fromEntries(byStatus.map((b) => [b.status, b._count._all]));
    assert.equal(map.P, totalExpected, `statuses: ${JSON.stringify(map)}`);
    return `all ${totalExpected} are P`;
  });

  await check("T1: the tap log records every mark once as 'marked' — the audit trail the spec requires", async () => {
    const taps = await db.tagTap.groupBy({
      by: ["outcome"], where: { sessionId: { in: plainSessions }, method: "teams" }, _count: { _all: true },
    });
    const map = Object.fromEntries(taps.map((t) => [t.outcome, t._count._all]));
    assert.equal(map.marked, totalExpected, `outcomes: ${JSON.stringify(map)}`);
    assert.equal(map.already_marked, undefined, `nothing was collected twice yet: ${JSON.stringify(map)}`);
    return `${map.marked} 'marked' rows, no 'already_marked'`;
  });

  /* ------------------------------------------------- T2 RECOLLECT (the C-2 fix) */
  await check("T2 RECOLLECT: the state a run killed before teamsCollectedAt leaves behind", async () => {
    // Exactly what a process death between the tap rows and the collectedAt stamp
    // leaves: marks standing, tap rows written, the register still flagged uncollected.
    const cleared = await db.hndSession.updateMany({
      where: { id: { in: plainSessions } }, data: { teamsCollectedAt: null },
    });
    assert.equal(cleared.count, SESSIONS);
    const t0 = performance.now();
    const r = await sync();
    const took = ms(t0);
    assert.equal(r.status, 200, `HTTP ${r.status}`);
    const s = r.body.summary || r.body.run?.summary || r.body;
    assert.equal(Number(s.marksCreated), 0, `a recollection must write NOTHING new, got ${s.marksCreated}`);
    assert.equal(Number(s.marksSkippedExisting), totalExpected,
      `every mark should be skipped as existing, got ${s.marksSkippedExisting}`);
    const inDb = await db.attendanceMark.count({ where: { sessionId: { in: plainSessions } } });
    assert.equal(inDb, totalExpected, `the register grew: ${inDb}`);
    // This is the number the authorship pre-read buys: the cost of deciding "already
    // written" for two thousand students with nothing to insert.
    return `0 new marks, ${s.marksSkippedExisting} skipped, in ${took}ms (${rate(totalExpected, took)} decided)`;
  });

  await check("T2: the tap log says 'already_marked' — a recollection never double-counts a student", async () => {
    const taps = await db.tagTap.groupBy({
      by: ["outcome"], where: { sessionId: { in: plainSessions }, method: "teams" }, _count: { _all: true },
    });
    const map = Object.fromEntries(taps.map((t) => [t.outcome, t._count._all]));
    assert.equal(map.marked, totalExpected,
      `'marked' must still be ${totalExpected} — a second one per student means the log claims they were marked twice (got ${map.marked})`);
    assert.equal(map.already_marked, totalExpected, `expected ${totalExpected} 'already_marked', got ${map.already_marked}`);
    return `marked=${map.marked} (unchanged) · already_marked=${map.already_marked}`;
  });

  /* ---------------------------------------------------------------- T3 SERIES */
  await check(`T3 SERIES: one recurring meeting id serving ${WEEKS} registers keeps the weeks apart`, async () => {
    const marks = await db.attendanceMark.findMany({
      where: { sessionId: { in: seriesSessions.map((s) => s.id) } },
      select: { sessionId: true, studentId: true, status: true },
    });
    // Each week's report named exactly one attendee; everyone else on that week's roster
    // is a measured absence. A collector that merged the occurrences would make every
    // week's named student Present on every week.
    for (const w of seriesSessions) {
      const mine = marks.filter((m) => m.sessionId === w.id);
      assert.equal(mine.length, STUDENTS, `week ${w.date} has ${mine.length} marks, expected ${STUDENTS}`);
      const present = mine.filter((m) => m.status === "P");
      assert.equal(present.length, 1, `week ${w.date} has ${present.length} students Present, expected exactly 1`);
      assert.equal(present[0].studentId, w.ownerId, `week ${w.date} credited the wrong student`);
    }
    return `${WEEKS} weeks, each with exactly its own attendee Present`;
  });

  /* ------------------------------------------------------------- T4 STRANGERS */
  await check(`T4 STRANGERS: ${STRANGERS} unidentifiable-to-us participants are reported, never guessed`, async () => {
    const marks = await db.attendanceMark.count({ where: { sessionId: strangerSession.id } });
    assert.equal(marks, STUDENTS,
      `only the ${STUDENTS} rostered students may be marked, got ${marks} — a stranger reached a register`);
    // summary and issues are JSON *strings* on this model, not Json columns.
    const parse = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };
    const runs = (await db.teamsSync.findMany({ orderBy: { startedAt: "desc" }, take: 3 }))
      .map((r) => ({ ...r, summary: parse(r.summary, {}), issues: parse(r.issues, []) }));
    const withStrangers = runs.find((r) => Number(r.summary?.participantsUnmatched) > 0);
    assert.ok(withStrangers, "the run must report the unmatched participants it saw");
    const unmatched = Number(withStrangers.summary.participantsUnmatched);
    assert.ok(unmatched >= STRANGERS, `participantsUnmatched=${unmatched}, expected at least ${STRANGERS}`);
    const issues = Array.isArray(withStrangers.issues) ? withStrangers.issues : [];
    const bytes = JSON.stringify(issues).length;
    // Reported rather than asserted at a limit: there is no cap in the code today, so
    // this line exists to put a number on how big one run's issues list can get.
    return `unmatched=${unmatched} · issues entries=${issues.length} · issues JSON=${(bytes / 1024).toFixed(1)}KB · marks still ${marks}`;
  });

  await check("T4: a stranger's email never becomes a student, and no mark carries one", async () => {
    const strangerStudents = await db.student.count({ where: { email: { contains: "@elsewhere.example" } } });
    assert.equal(strangerStudents, 0, `${strangerStudents} stranger(s) were created as students`);
    const rostered = new Set(made.students);
    const marks = await db.attendanceMark.findMany({ where: { sessionId: strangerSession.id }, select: { studentId: true } });
    const foreign = marks.filter((m) => !rostered.has(m.studentId));
    assert.equal(foreign.length, 0, `${foreign.length} marks belong to nobody on the roster`);
    return "no student created, no foreign mark";
  });

  /* ----------------------------------------------- T5 the retry window boundary */
  await check(`T5 WINDOW: a register ${RETRY_DAYS + 1} days old is not collected, report or no report`, async () => {
    const marks = await db.attendanceMark.count({ where: { sessionId: staleSession.id } });
    assert.equal(marks, 0,
      `${marks} mark(s) written for ${STALE_DATE}, which is outside the ${RETRY_DAYS}-day window`);
    const fresh = await db.hndSession.findUnique({ where: { id: staleSession.id }, select: { teamsCollectedAt: true } });
    assert.equal(fresh.teamsCollectedAt, null, "an uncollected register must not be stamped as collected");
    return `${STALE_DATE} left alone — 0 marks, teamsCollectedAt still null`;
  });

  /* ----------------------------------------------------- the run log is honest */
  await check("the run log records both runs, neither still 'running'", async () => {
    const runs = await db.teamsSync.findMany({ orderBy: { startedAt: "desc" }, take: 2 });
    assert.equal(runs.length, 2, `${runs.length} run row(s)`);
    const stuck = runs.filter((r) => r.status === "running");
    assert.equal(stuck.length, 0, `${stuck.length} run(s) left flagged running`);
    return `statuses: ${runs.map((r) => r.status).join(", ")}`;
  });
} catch (e) {
  bad("the stress run itself threw", e);
} finally {
  console.log("\ncleaning up…");
  await cleanup();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
