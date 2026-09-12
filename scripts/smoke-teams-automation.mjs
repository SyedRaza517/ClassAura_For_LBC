// Teams automation — meeting creation and Team provisioning, weighted toward what the
// engines must never do twice and what they must never do while switched off.
//
// TWO ENGINES, ONE SUITE. teamsMeetings.js (Phase A) books a Teams meeting for a
// timetabled online class and keeps it in step with the timetable; teamsProvisioning.js
// (Phase B) creates a class Team and its unit channels and keeps membership current.
// They are independent switches sharing one settings row and one run log
// (TeamsProvisionSync, discriminated by `job`) — see routes/teamsAutomation.js's own
// header — so one suite covering both, in the order a college would actually flip them
// on, is truer to how they are used than two suites that never see the other running.
//
// THE PATCH GATE THIS SUITE EXISTS TO PIN. teamsMeetings.js's own header explains that
// comparing TimetableEvent.updatedAt against teamsMeetingSyncedAt never closed — the
// very write that stored teamsMeetingSyncedAt bumped updatedAt to a LATER instant,
// so every owned meeting was re-PATCHed (and every attendee re-notified) on every
// single hourly tick forever, whether or not anything about the meeting had changed.
// meetingFingerprint replaced that comparison and teamsMeetings.test.js proves the pure
// function is stable, but the regression that actually happened was never in the pure
// function — it was in the gate calling it correctly from a real sync loop against a
// real database. So after this suite proves ONE reschedule produces ONE updateClassMeeting
// (scenario 4), it runs a THIRD sync with nothing changed at all and asserts
// meetingsUpdated is zero and no new update line lands in the journal — the one
// assertion an engine review ruled this suite cannot skip, because "the gate looked
// right" is exactly what the interim version also looked like.
//
// PROVISIONING IS ADDITIVE-ONLY (constraints.md), so its own regression shape is
// different: not "does it repeat a write", but "does it repeat the WRONG write". A
// second provisioning run against an unchanged timetable must create no second Team and
// no second channel — CohortTeam and UnitChannel exist once — while still being allowed,
// and expected, to re-add the same members it added the first time, because that is what
// "never remove, never rename, but never falls behind either" costs on every run.
//
// THE FIXTURES SEAM, extended for writes. TEAMS_GRAPH_FIXTURES answers `users` (email ->
// Entra id) exactly as smoke-teams-attendance.mjs's fixtures do; neither engine here ever
// calls calendarView, resolveMeetingId or attendanceIntervals, so this suite's fixtures
// file carries only two keys: `users`, and (fix 8, engine review) `channelEmails` —
// chan-<slug> -> address, read once per channel by teamsProvisioning.js's
// getChannelEmail() so scenario 9 below can prove the address it learns is actually
// invited to a class meeting, not merely resolved and cached. TEAMS_GRAPH_JOURNAL is new
// for this suite: every write op (createClassMeeting, updateClassMeeting,
// cancelClassMeeting, createTeam, createChannel, addTeamMember) appends one JSON line
// `{ op, args }`, which is the only way to prove "a meeting was created with these
// times" or "no second Team was created" without a Microsoft tenant to look inside.
// Fixture ids are DETERMINISTIC — cal-<subject slug>, team-<name slug>, chan-<name
// slug> — so a suite reading them back does not have to invent a way to learn what the
// fixture branch just minted.
//
// ITS OWN API, ITS OWN PORT, for the same reason smoke-teams-attendance.mjs gives at
// length: `npm test` boots one shared API on port 4010 with one fixed environment, and
// TEAMS_GRAPH_FIXTURES/TEAMS_GRAPH_JOURNAL are env vars the API must be STARTED with.
// This suite spawns its own process on a THIRD port (neither 4010 nor 4017, which the
// attendance suite already owns), against the same DATABASE_URL and the same seeded
// fixtures (admin@edtech.co.uk et al.) as everything else in the run.
//
//   node scripts/smoke-teams-automation.mjs
//   (needs DATABASE_URL; SEED_PASSWORD defaults to the one `npm test` seeds with)
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const server = join(root, "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

// Exit 2 = SKIP, matching every other suite's convention: a suite that could not run
// (no database to point an API at) must not be confused with one whose assertions ran
// and passed.
if (!process.env.DATABASE_URL) {
  console.log("SKIP — DATABASE_URL is not set, so there is no database to run this suite against");
  process.exit(2);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));

const RUN = Date.now().toString(36);
// Neither 4010 (the shared `npm test` API) nor 4017 (smoke-teams-attendance.mjs's own
// spawned instance, which can run in the same `npm test` invocation) — a third port so
// the two Teams suites can both spawn their private processes without colliding.
const PORT = Number(process.env.TEAMS_AUTOMATION_SMOKE_PORT || 4019);
const API = `http://127.0.0.1:${PORT}/api`;
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;
const SEED_PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
// A throwaway key per run, never the outer `npm test` run's — this suite is a second
// process with its own environment and must not depend on (or leak into) whatever the
// shared instance happens to be configured with.
const CREDENTIALS_KEY = randomBytes(32).toString("base64");
const JWT_SECRET = "teams-automation-smoke-secret-not-for-production";
const FIXTURES_PATH = join(tmpdir(), `teams-automation-fixtures-${RUN}.json`);
const JOURNAL_PATH = join(tmpdir(), `teams-automation-journal-${RUN}.ndjson`);

const ZONE = process.env.APP_TIMEZONE || "Europe/London";
const isoOffset = (days) => new Date(Date.now() + days * 86400000).toLocaleDateString("en-CA", { timeZone: ZONE });
const D7 = isoOffset(7); // "+7 days", per the brief — comfortably inside the reconciler's yesterday..+14 window

// A bare client, exactly as smoke-teams-attendance.mjs uses one: it plants seed data
// no route needs to accept from a form and reads back what the engines actually wrote,
// including columns (teamsCalendarEventId, teamsMeetingFingerprint) no serialiser ships
// to the browser.
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

// Every write op teamsGraph.js's fixture branches append, read fresh — the file grows
// across the whole suite, so callers filter by `op` rather than assuming the file holds
// only what the last action wrote.
function readJournal() {
  let raw = "";
  try { raw = readFileSync(JOURNAL_PATH, "utf8"); } catch { return []; } // not written yet
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
const journalCount = (op) => readJournal().filter((j) => j.op === op).length;

// --- Emails, all RUN-suffixed so a run never collides with a previous one's leftovers.
const ORG_EMAIL = `organizer-${RUN}@x.ac.uk`; // also the creator account — creatorEmail() defaults to organizerAccounts[0]
const TEACHER_EMAIL = `teacher-${RUN}@x.ac.uk`;
const S1_EMAIL = `s1-${RUN}@x.ac.uk`; // resolvable — appears in fixtures.users
const S2_EMAIL = `s2-${RUN}@x.ac.uk`; // resolvable — appears in fixtures.users
// DELIBERATELY ABSENT FROM fixtures.users. This is scenario 7's unmatched student: a
// real cohort member whose Microsoft account this fixture tenant does not have, so
// resolveUserId() answers null exactly as it would for a real un-matched person —
// reported on the run log, never guessed onto a Team (constraints.md).
const S3_EMAIL = `s3-${RUN}@x.ac.uk`;

const ORG_ID = "org1", TEACHER_ID = "staff1", S1_ID = "student1", S2_ID = "student2";

// A valid-shaped pasted join link — parseJoinUrl (teamsAttendance.js) asks only for the
// https://teams.microsoft.com/l/meetup-join/ prefix, exactly as smoke-teams-attendance's
// own joinUrl() fixture builder relies on.
const PASTED_URL = `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${RUN}_pasted%40thread.v2/0`;

// Odd minutes, deliberately not on the hour or half hour — the same reasoning
// smoke-teams-attendance.mjs gives at length: prisma/seed.js's own weekly timetable
// sits at 10:00/14:00/18:00, and landing off those keeps this suite's slots from ever
// coinciding with it, on any day this happens to run.
const T_A = { start: "09:15", end: "10:45" }; // event A — created, rescheduled, cancelled
const T_A2 = { start: "09:45", end: "11:15" }; // event A after its one reschedule
const T_B = { start: "13:20", end: "14:50" }; // event B — the pasted-link event, never touched
const T_C = { start: "15:35", end: "17:05" }; // event C — scenario 9's own, added once a channel exists to invite

// This suite's own unit, named AHEAD of creating it. teamsProvisioning.js's channel
// display name (fix 3, engine review) is "<code> — <name>", truncateName'd to Graph's
// 50-char channel limit — short enough here to never hit that cap, the same "reproduced
// short enough to never truncate" idiom expectedTeamName below already relies on for the
// Team's own name. Named ahead of the seed step because the fixture channel-email map
// below (CHANNEL_ID) has to be written to disk BEFORE the API process — and therefore
// createChannel — ever starts, and createChannel's own fixture id is deterministic from
// exactly this string.
const UNIT_CODE = `TMA${RUN}`.slice(0, 12);
const UNIT_NAME = `Teams Automation Unit ${RUN}`;
const CHANNEL_DISPLAY_NAME = [UNIT_CODE, UNIT_NAME].filter(Boolean).join(" — ");
const CHANNEL_ID = `chan-${slugify(CHANNEL_DISPLAY_NAME)}`;
// The address getChannelEmail() answers for THIS suite's own channel, once provisioning
// creates it (scenario 7) — every OTHER channel in this run gets the fixture default of
// null ("this tenant has no channel email"; see teamsGraph.js's getChannelEmail), so
// keying this to CHANNEL_ID is what singles this one channel out for scenario 9 to
// actually exercise the invite.
const CHANNEL_EMAIL = `channel-${RUN}@x.ac.uk`;

const made = { events: [] };
let unit = null, cohort = null, course = null, teacher = null;
let s1 = null, s2 = null, s3 = null;
let child = null, bootLog = "";
let integrationExisted = false, priorIntegration = null;
let automationConfigExisted = false, priorAutomationSettings = null;
let priorAdminPages;
let runStart; // set just before the first engine run — cleanup scopes TeamsProvisionSync deletion to it

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
    // Events first — TimetableEventGroup/TimetableEventStaff are Cascade off the event,
    // so this also removes both assignment rows. It does NOT remove the HndSession
    // registers those events built: HndSession.timetableEventId is SetNull (deleting a
    // timetable entry must never delete attendance — see schema.prisma), so the register
    // rows survive this step with a null FK and are reaped below via the unit.
    for (const id of made.events) await db.timetableEvent.delete({ where: { id } }).catch(() => {});

    // HndSession.unitId is NOT NULL with onDelete: Cascade (unlike timetableEventId),
    // so deleting the unit removes every register this suite's events built — including
    // the ones just orphaned above — in one statement. UnitChannel is Cascade off the
    // unit too, so provisioning's channel row goes with it regardless of whether the
    // cohort delete below reaches it first.
    if (unit) await db.unit.delete({ where: { id: unit.id } }).catch(() => {});

    for (const s of [s1, s2, s3]) if (s) await db.student.delete({ where: { id: s.id } }).catch(() => {});
    if (teacher) await db.staff.delete({ where: { id: teacher.id } }).catch(() => {});
    // Cohort last of the academic rows — CohortTeam is Cascade off it, so any
    // provisioning row this suite created goes with it even if the unit delete above
    // did not already remove UnitChannel first.
    if (cohort) await db.cohort.delete({ where: { id: cohort.id } }).catch(() => {});
    if (course) await db.course.delete({ where: { id: course.id } }).catch(() => {});

    // This suite's own runs, only — scoped by startedAt rather than a bare
    // deleteMany({}), for the same reason smoke-teams-attendance.mjs scopes its TeamsSync
    // cleanup the same way: a table-wide delete would take down rows this run never
    // touched the moment anything else in the same DATABASE_URL ever writes one.
    if (runStart) await db.teamsProvisionSync.deleteMany({ where: { startedAt: { gte: runStart } } }).catch(() => {});

    // PROVISIONING IS INSTITUTION-WIDE BY DESIGN (constraints.md, and
    // teamsProvisioning.js's own header): it scans every PUBLISHED cohort in the
    // college, not merely the one this suite seeded. Run against a development database
    // that already has other published cohorts sitting with no CohortTeam yet — exactly
    // the ordinary state of a college that has never turned this switch on — and
    // scenario 7's run-provisioning call creates a real (fixture-mode) Team for every
    // one of them, not only for this suite's own. That is the feature working
    // correctly, not a leak in the suite, but it is still this suite's mess to clean up:
    // left alone, every OTHER cohort in the shared dev database would carry a
    // permanent CohortTeam row after the FIRST time anyone ran this suite locally, and
    // `npm test` a second time would find those cohorts already "provisioned" and never
    // touch them again — a false green forever after.
    //
    // Scoped by createdAt, the same idiom as the TeamsProvisionSync cleanup just above:
    // a row created before this suite's own run predates it and is left alone (it was
    // either provisioned by a real admin or by an earlier run of this suite that failed
    // to clean up, either way not this run's to delete); everything from `runStart`
    // onward is this run's own footprint, whichever cohort it landed on.
    // UnitChannel.onDelete is Cascade off CohortTeam, so this removes both in one
    // statement without needing to know which units were involved.
    if (runStart) await db.cohortTeam.deleteMany({ where: { createdAt: { gte: runStart } } }).catch(() => {});

    // Put the "teams" integration and TeamsAutomationConfig back exactly as found — the
    // same upsert-on-singleton idiom smoke-teams-attendance.mjs uses, for the same
    // reason: a college left with automation switched on, or credentials it never
    // entered, is the one piece of state here that would otherwise change the real
    // product rather than merely this suite's own rows.
    if (integrationExisted) {
      const { id, ...rest } = priorIntegration;
      await db.tenantIntegration.update({ where: { id }, data: rest }).catch(() => {});
    } else {
      await db.tenantIntegration.deleteMany({ where: { provider: "teams" } }).catch(() => {});
    }
    if (automationConfigExisted) {
      await db.teamsAutomationConfig.upsert({
        where: { id: "singleton" }, update: { settings: priorAutomationSettings }, create: { id: "singleton", settings: priorAutomationSettings },
      }).catch(() => {});
    } else {
      await db.teamsAutomationConfig.deleteMany({}).catch(() => {});
    }
    if (priorAdminPages !== undefined) {
      await db.staff.update({ where: { id: "admin" }, data: { adminPages: priorAdminPages } }).catch(() => {});
    }
  } catch (e) {
    console.error("cleanup problem:", e.message);
  }
  try { unlinkSync(FIXTURES_PATH); } catch { /* never written, or already gone */ }
  try { unlinkSync(JOURNAL_PATH); } catch { /* never written, or already gone */ }
}

try {
  // ====================================================================================
  // Fixtures file FIRST — it must exist on disk before the API process that reads it
  // (fresh, on every call — see teamsGraph.js) is even spawned. No `organizers`,
  // `calendars`, `meetingIds` or `attendance` keys: neither engine under test ever calls
  // resolveOrganizers, calendarView, resolveMeetingId or attendanceIntervals — those are
  // smoke-teams-attendance.mjs's territory. `users` is the one key resolveCreatorId()
  // and resolveUserId() both read.
  // ====================================================================================
  const fixtures = {
    users: {
      [ORG_EMAIL.toLowerCase()]: ORG_ID,
      [TEACHER_EMAIL.toLowerCase()]: TEACHER_ID,
      [S1_EMAIL.toLowerCase()]: S1_ID,
      [S2_EMAIL.toLowerCase()]: S2_ID,
      // S3_EMAIL is deliberately absent — see its declaration above.
    },
    // Channel-email invite coverage (fix 8, engine review) — see CHANNEL_ID/CHANNEL_EMAIL's
    // own comments above for why this is keyed and written before provisioning ever runs.
    channelEmails: { [CHANNEL_ID]: CHANNEL_EMAIL },
  };
  writeFileSync(FIXTURES_PATH, JSON.stringify(fixtures, null, 2));

  // ====================================================================================
  // This suite's own API, spawned with both the fixtures and the journal seams wired in.
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
      TEAMS_GRAPH_JOURNAL: JOURNAL_PATH,
      // No caches: this suite writes settings and expects the very next call to see
      // them, and — unlike the shared runner — controls this whole process itself, so
      // nothing is lost by disabling every short-lived cache in the path.
      TEAMS_AUTOMATION_CACHE_MS: "0",
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
  // Seed: a course/cohort/unit, one teacher, three students — two resolvable against
  // this fixture tenant, one deliberately not. No Enrolment rows: with none, roster.js's
  // unitHasEnrolments is false and every register falls to the cohort-only branch, which
  // is exactly the roster this suite needs and one fewer table to seed and clean up.
  // ====================================================================================
  const adminLogin = await login("admin@edtech.co.uk", SEED_PASSWORD);
  const adminToken = adminLogin.data?.token;
  if (!adminToken) throw new Error(`admin sign-in failed (HTTP ${adminLogin.status}) — cannot run this suite`);

  // The seeded admin's adminPages is NULL by default (unconfigured -> full access —
  // see auth.js's hasPage), which already covers every page this suite needs. Granted
  // explicitly anyway, and to THREE pages rather than smoke-teams-attendance.mjs's two:
  // "attendance-settings" for the run-meetings/run-provisioning/settings/runs endpoints
  // (routes/teamsAutomation.js's own header explains why they share attendance's page
  // rather than "settings"), "settings" for PUT /integrations/teams (credentials stay
  // institution-wide, same category as branding), and "scheduling" — which
  // smoke-teams-attendance.mjs has no need of — because this suite creates and edits
  // TimetableEvents through routes/timetabling.js, which is gated on that page alone.
  // Setting adminPages to an ARRAY is a NARROWING (hasPage's array branch checks literal
  // membership, not "everything except explicit-only pages"), so leaving any of the
  // three out would 403 the very call this suite is about to make.
  const priorAdminRow = await db.staff.findUnique({ where: { id: "admin" }, select: { adminPages: true } });
  priorAdminPages = priorAdminRow?.adminPages ?? null;
  await db.staff.update({ where: { id: "admin" }, data: { adminPages: JSON.stringify(["settings", "attendance-settings", "scheduling"]) } });

  course = await db.course.create({ data: { name: `Teams Automation Course ${RUN}` } });
  cohort = await db.cohort.create({ data: { courseId: course.id, name: `Teams Automation Intake ${RUN}` } });
  unit = await db.unit.create({ data: {
    code: UNIT_CODE, name: UNIT_NAME, courseId: course.id,
    startDate: D7, endDate: D7,
  } });

  // A real Staff row rather than one of the seeded fixtures — this suite needs an email
  // this fixture tenant resolves, which none of the seeded staff carry.
  teacher = await db.staff.create({ data: {
    name: `Teams Teacher ${RUN}`, jobTitle: "Lecturer", dept: "Teaching", email: TEACHER_EMAIL, passwordHash: "unused",
    initials: "TT", colour: "#1a73e8",
  } });

  const mkStudent = (n, email) => db.student.create({ data: {
    firstName: `Auto${n}`, lastName: `Suite${RUN}`, studentRef: `TMA${RUN}${n}`, email,
    initials: `A${n}`, colour: "#1a73e8", cohortId: cohort.id,
  } });
  s1 = await mkStudent(1, S1_EMAIL);
  s2 = await mkStudent(2, S2_EMAIL);
  s3 = await mkStudent(3, S3_EMAIL); // the unresolvable one

  /* ====================================================================== */
  console.log("\n--- refused before Teams is configured at all ---");
  /* ====================================================================== */

  const unconfiguredMeetings = await call("/teams-automation/run-meetings", { method: "POST", token: adminToken });
  check("run-meetings is refused before credentials exist", unconfiguredMeetings.status === 409, `HTTP ${unconfiguredMeetings.status}`);
  check("...and says so", /not configured/i.test(unconfiguredMeetings.data?.error || ""), unconfiguredMeetings.data?.error);

  const unconfiguredProvisioning = await call("/teams-automation/run-provisioning", { method: "POST", token: adminToken });
  check("run-provisioning is refused before credentials exist", unconfiguredProvisioning.status === 409, `HTTP ${unconfiguredProvisioning.status}`);
  check("...and says so", /not configured/i.test(unconfiguredProvisioning.data?.error || ""), unconfiguredProvisioning.data?.error);

  /* ====================================================================== */
  console.log("\n--- configuring credentials ---");
  /* ====================================================================== */

  const priorIntegrationRow = await db.tenantIntegration.findFirst({ where: { provider: "teams" } });
  integrationExisted = Boolean(priorIntegrationRow);
  priorIntegration = priorIntegrationRow;

  const priorAutomationRow = await db.teamsAutomationConfig.findFirst({});
  automationConfigExisted = Boolean(priorAutomationRow);
  priorAutomationSettings = priorAutomationRow?.settings ?? {};

  // No creatorAccount sent: creatorEmail() falls back to organizerAccounts[0], which is
  // exactly what this suite wants — one account playing organizer and creator both.
  const savedIntegration = await call("/integrations/teams", {
    method: "PUT", token: adminToken,
    body: { tenantId: "fake-tenant", clientId: "fake-client", clientSecret: "fake-secret", organizerAccounts: ORG_EMAIL, enabled: true },
  });
  check("an administrator can save Teams credentials", savedIntegration.status === 200 && savedIntegration.data?.configured === true, `HTTP ${savedIntegration.status}`);

  /* ====================================================================== */
  console.log("\n--- scenario 1: both switches off, after credentials configured — the ship-off proof ---");
  /* ====================================================================== */

  // THE WINDOW THIS SCENARIO EXISTS FOR: credentials are saved and graph.isConfigured()
  // now answers true, but TeamsAutomationConfig's own switches are still both false —
  // the gap between "an admin pressed Test connection" and "an admin trusts this enough
  // to turn it on". OFF MEANS NOTHING RUNS (constraints.md): no Graph call of any kind,
  // for either engine, while its own switch is off.
  const offMeetings = await call("/teams-automation/run-meetings", { method: "POST", token: adminToken });
  check("run-meetings is refused while configured but switched off", offMeetings.status === 409, `HTTP ${offMeetings.status}`);
  check("...and says so", /switched off/i.test(offMeetings.data?.error || ""), offMeetings.data?.error);

  const offProvisioning = await call("/teams-automation/run-provisioning", { method: "POST", token: adminToken });
  check("run-provisioning is refused while configured but switched off", offProvisioning.status === 409, `HTTP ${offProvisioning.status}`);
  check("...and says so", /switched off/i.test(offProvisioning.data?.error || ""), offProvisioning.data?.error);

  check("neither refusal reached Microsoft — the journal is still empty", readJournal().length === 0, `${readJournal().length} line(s)`);

  /* ====================================================================== */
  console.log("\n--- enabling meeting creation only ---");
  /* ====================================================================== */

  const enabledMeetings = await call("/teams-automation/settings", { method: "PUT", token: adminToken, body: { autoCreateMeetings: true } });
  check("meeting creation switches on", enabledMeetings.status === 200 && enabledMeetings.data?.settings?.autoCreateMeetings === true, `HTTP ${enabledMeetings.status}`);
  check("...leaving provisioning off (a patch, not a replace)", enabledMeetings.data?.settings?.provisionTeams === false, JSON.stringify(enabledMeetings.data?.settings));

  const settingsNow = await call("/teams-automation/settings", { token: adminToken });
  check("the settings screen now reports the integration as configured", settingsNow.data?.configured === true, `configured=${settingsNow.data?.configured}`);

  /* ====================================================================== */
  console.log("\n--- scenario 2: a published, teamsAutoMeeting event gets a meeting ---");
  /* ====================================================================== */

  const titleA = `Teams Automation Class ${RUN}`;
  const createdA = await call("/timetabling/events", {
    method: "POST", token: adminToken,
    body: {
      date: D7, start: T_A.start, end: T_A.end, title: titleA,
      unitId: unit.id, courseId: course.id, cohortIds: [cohort.id], staffIds: [teacher.id],
      published: true, teamsAutoMeeting: true,
    },
  });
  check("event A is created", createdA.status === 201, `HTTP ${createdA.status} ${JSON.stringify(createdA.data)}`);
  const eventAId = createdA.data?.event?.id;
  made.events.push(eventAId);
  check("...and its register was built on create, not left for a later publish", createdA.data?.registers?.created === 1, JSON.stringify(createdA.data?.registers));

  const titleB = `Teams Automation Pasted ${RUN}`;
  const createdB = await call("/timetabling/events", {
    method: "POST", token: adminToken,
    body: {
      date: D7, start: T_B.start, end: T_B.end, title: titleB,
      unitId: unit.id, courseId: course.id, cohortIds: [cohort.id], staffIds: [teacher.id],
      published: true, teamsAutoMeeting: true, teamsJoinUrl: PASTED_URL,
    },
  });
  check("event B (pasted link) is created", createdB.status === 201, `HTTP ${createdB.status} ${JSON.stringify(createdB.data)}`);
  const eventBId = createdB.data?.event?.id;
  made.events.push(eventBId);
  check("...and its register carries the pasted url from creation", createdB.data?.registers?.created === 1, JSON.stringify(createdB.data?.registers));

  const sessionB0 = await db.hndSession.findFirst({ where: { timetableEventId: eventBId } });
  check("event B's register already has the pasted url before any sync has run", sessionB0?.teamsJoinUrl === PASTED_URL, sessionB0?.teamsJoinUrl);

  runStart = new Date(); // captured before the first engine run — see cleanup()'s use of it

  const sync1 = await call("/teams-automation/run-meetings", { method: "POST", token: adminToken });
  check("the first meetings sync runs and answers 200", sync1.status === 200, `HTTP ${sync1.status} ${sync1.data?.error || ""}`);
  check("it created exactly one meeting", sync1.data?.summary?.meetingsCreated === 1, JSON.stringify(sync1.data?.summary));
  check("it cancelled and updated nothing", sync1.data?.summary?.meetingsCancelled === 0 && sync1.data?.summary?.meetingsUpdated === 0, JSON.stringify(sync1.data?.summary));

  const createLines1 = readJournal().filter((j) => j.op === "createClassMeeting");
  check("the journal holds exactly one createClassMeeting", createLines1.length === 1, `${createLines1.length}`);
  check("...for event A's own title", createLines1[0]?.args?.subject === titleA, createLines1[0]?.args?.subject);
  check("...at event A's own London times", createLines1[0]?.args?.startTime === T_A.start && createLines1[0]?.args?.endTime === T_A.end,
    `${createLines1[0]?.args?.startTime}-${createLines1[0]?.args?.endTime}`);
  check("...addressed to the teacher", (createLines1[0]?.args?.attendeeEmails || []).includes(TEACHER_EMAIL), JSON.stringify(createLines1[0]?.args?.attendeeEmails));

  const eventAAfter1 = await db.timetableEvent.findUnique({ where: { id: eventAId } });
  check("event A now carries the fixture calendar event id", eventAAfter1?.teamsCalendarEventId === `cal-${slugify(titleA)}`, eventAAfter1?.teamsCalendarEventId);
  const fixtureJoinUrlA = `https://teams.microsoft.com/l/meetup-join/fixture-${slugify(titleA)}`;
  check("...and the fixture join url", eventAAfter1?.teamsJoinUrl === fixtureJoinUrlA, eventAAfter1?.teamsJoinUrl);
  check("...with a fingerprint recorded for the idempotence gate", !!eventAAfter1?.teamsMeetingFingerprint, eventAAfter1?.teamsMeetingFingerprint);

  const sessionA1 = await db.hndSession.findFirst({ where: { timetableEventId: eventAId } });
  check("event A's register inherited the join url", sessionA1?.teamsJoinUrl === fixtureJoinUrlA, sessionA1?.teamsJoinUrl);
  check("...and the resolved organizer id", sessionA1?.teamsOrganizerId === ORG_ID, sessionA1?.teamsOrganizerId);

  const eventBAfter1 = await db.timetableEvent.findUnique({ where: { id: eventBId } });
  check("event B (the paste) was never touched — no calendar event id was ever resolved for it",
    eventBAfter1?.teamsCalendarEventId == null, eventBAfter1?.teamsCalendarEventId);
  check("...and its pasted url is exactly what was typed, not the fixture's own", eventBAfter1?.teamsJoinUrl === PASTED_URL, eventBAfter1?.teamsJoinUrl);
  check("the journal never names event B's title at all — it was skipped before any Graph call",
    !readJournal().some((j) => j.args?.subject === titleB), "");

  /* ====================================================================== */
  console.log("\n--- scenario 3: idempotence — a second sync creates nothing new ---");
  /* ====================================================================== */

  const sync2 = await call("/teams-automation/run-meetings", { method: "POST", token: adminToken });
  check("the second sync still answers 200", sync2.status === 200, `HTTP ${sync2.status}`);
  check("it created no new meeting", sync2.data?.summary?.meetingsCreated === 0, JSON.stringify(sync2.data?.summary));
  check("...and the journal still holds exactly one createClassMeeting", journalCount("createClassMeeting") === 1, `${journalCount("createClassMeeting")}`);

  /* ====================================================================== */
  console.log("\n--- scenario 4: rescheduling produces exactly one update, never a duplicate create ---");
  /* ====================================================================== */

  const rescheduled = await call(`/timetabling/events/${eventAId}`, { method: "PUT", token: adminToken, body: { start: T_A2.start, end: T_A2.end } });
  check("event A can be rescheduled", rescheduled.status === 200, `HTTP ${rescheduled.status}`);
  check("...and its register followed the move rather than freezing (no marks exist yet)",
    rescheduled.data?.registers?.updated === 1 && (rescheduled.data?.registers?.frozen || []).length === 0, JSON.stringify(rescheduled.data?.registers));

  const sync3 = await call("/teams-automation/run-meetings", { method: "POST", token: adminToken });
  check("the third sync answers 200", sync3.status === 200, `HTTP ${sync3.status}`);
  check("it updated exactly the rescheduled meeting", sync3.data?.summary?.meetingsUpdated === 1, JSON.stringify(sync3.data?.summary));
  check("...and created no duplicate", sync3.data?.summary?.meetingsCreated === 0, JSON.stringify(sync3.data?.summary));
  check("the journal now holds exactly one updateClassMeeting", journalCount("updateClassMeeting") === 1, `${journalCount("updateClassMeeting")}`);
  check("...and still exactly one createClassMeeting — the reschedule PATCHed, it did not re-create", journalCount("createClassMeeting") === 1, `${journalCount("createClassMeeting")}`);

  /* ====================================================================== */
  console.log("\n--- THE REGRESSION RULING: a fourth sync, nothing changed, must PATCH nothing ---");
  // This is the assertion the interim updatedAt-based gate could never have passed: that
  // gate re-PATCHed every owned meeting on every tick regardless of whether anything
  // about it had changed, because the very act of PATCHing bumped the timestamp the gate
  // compared against. meetingFingerprint replaced it, and this is where that fix is
  // actually exercised end to end rather than only in teamsMeetings.test.js's pure
  // function tests.
  /* ====================================================================== */

  const sync4 = await call("/teams-automation/run-meetings", { method: "POST", token: adminToken });
  check("the fourth sync answers 200", sync4.status === 200, `HTTP ${sync4.status}`);
  check("THE GATE THAT ONCE NEVER CLOSED: it updated nothing when nothing changed", sync4.data?.summary?.meetingsUpdated === 0, JSON.stringify(sync4.data?.summary));
  check("...and the journal gained no second updateClassMeeting line", journalCount("updateClassMeeting") === 1, `${journalCount("updateClassMeeting")}`);

  /* ====================================================================== */
  console.log("\n--- scenario 6: unpublishing cancels the meeting this system owns ---");
  /* ====================================================================== */

  const unpublished = await call(`/timetabling/events/${eventAId}`, { method: "PUT", token: adminToken, body: { published: false } });
  check("event A can be unpublished", unpublished.status === 200, `HTTP ${unpublished.status}`);

  const sync5 = await call("/teams-automation/run-meetings", { method: "POST", token: adminToken });
  check("the fifth sync answers 200", sync5.status === 200, `HTTP ${sync5.status}`);
  check("it cancelled exactly the meeting it owned", sync5.data?.summary?.meetingsCancelled === 1, JSON.stringify(sync5.data?.summary));
  check("the journal holds exactly one cancelClassMeeting", journalCount("cancelClassMeeting") === 1, `${journalCount("cancelClassMeeting")}`);

  const eventAAfter5 = await db.timetableEvent.findUnique({ where: { id: eventAId } });
  check("event A's calendar event id is cleared", eventAAfter5?.teamsCalendarEventId == null, eventAAfter5?.teamsCalendarEventId);
  check("...its join url reset to the unset default", eventAAfter5?.teamsJoinUrl === "", JSON.stringify(eventAAfter5?.teamsJoinUrl));
  check("...its sync timestamp and fingerprint cleared, so a republish would not look like a divergence", eventAAfter5?.teamsMeetingSyncedAt == null && eventAAfter5?.teamsMeetingFingerprint == null, "");

  const sessionA5 = await db.hndSession.findFirst({ where: { timetableEventId: eventAId } });
  check("its register's join url is nulled — a cancelled meeting stops the attendance sync's retry window",
    sessionA5?.teamsJoinUrl == null, sessionA5?.teamsJoinUrl);
  check("...as is the resolved meeting id", sessionA5?.teamsMeetingId == null, sessionA5?.teamsMeetingId);
  check("...as is the resolved organizer id", sessionA5?.teamsOrganizerId == null, sessionA5?.teamsOrganizerId);

  const eventBAfter5 = await db.timetableEvent.findUnique({ where: { id: eventBId } });
  check("event B (the paste) is still completely untouched after five syncs", eventBAfter5?.teamsJoinUrl === PASTED_URL && eventBAfter5?.teamsCalendarEventId == null,
    `joinUrl=${eventBAfter5?.teamsJoinUrl} calendarEventId=${eventBAfter5?.teamsCalendarEventId}`);

  /* ====================================================================== */
  console.log("\n--- scenario 7: enabling provisioning creates a Team, its channel, and adds who it can match ---");
  /* ====================================================================== */

  // Event B is what keeps this cohort "in scope" from here on — it is the only event
  // still published, and provisioning's cohort/unit queries both require
  // `event: { published: true }`. Event A being unpublished (the scenario just above)
  // is deliberately irrelevant to what follows.
  const enabledProvisioning = await call("/teams-automation/settings", { method: "PUT", token: adminToken, body: { provisionTeams: true } });
  check("provisioning switches on", enabledProvisioning.status === 200 && enabledProvisioning.data?.settings?.provisionTeams === true, `HTTP ${enabledProvisioning.status}`);
  check("...leaving meeting creation as it was (still on) — a patch, not a replace", enabledProvisioning.data?.settings?.autoCreateMeetings === true, JSON.stringify(enabledProvisioning.data?.settings));

  const prov1 = await call("/teams-automation/run-provisioning", { method: "POST", token: adminToken });
  check("the first provisioning run answers 200", prov1.status === 200, `HTTP ${prov1.status} ${prov1.data?.error || ""}`);
  // AGGREGATE COUNTS ARE >=, NOT ===, AND DELIBERATELY. teamsCreated/channelsCreated are
  // institution-wide totals — this dev database's own seed data routinely holds OTHER
  // published cohorts with no CohortTeam yet, and provisioning correctly creates one for
  // every single one of them the first time anyone runs this suite locally, same as a
  // real admin flipping the switch would. Asserting "exactly 1" here would fail on any
  // database that is not pristine while proving nothing about THIS suite's own cohort —
  // which is why every assertion below is anchored to this cohort's own displayName or
  // groupId rather than a raw journal or summary total.
  check("it created at least this cohort's own Team", prov1.data?.summary?.teamsCreated >= 1, JSON.stringify(prov1.data?.summary));
  check("...and at least this cohort's own channel", prov1.data?.summary?.channelsCreated >= 1, JSON.stringify(prov1.data?.summary));
  check("it counted at least the one unresolvable student this suite seeded", prov1.data?.summary?.peopleUnmatched >= 1, JSON.stringify(prov1.data?.summary));
  check("...and named the unresolvable student rather than guessing them onto the Team",
    (prov1.data?.issues || []).some((i) => i.includes(S3_EMAIL)), JSON.stringify(prov1.data?.issues));

  const cohortTeam1 = await db.cohortTeam.findUnique({ where: { cohortId: cohort.id } });
  check("a CohortTeam row now exists for this cohort", !!cohortTeam1, "");
  const unitChannels1 = await db.unitChannel.findMany({ where: { cohortTeamId: cohortTeam1?.id } });
  check("...with exactly one UnitChannel", unitChannels1.length === 1, `${unitChannels1.length}`);

  // From here on, every check is scoped to THIS cohort's own Team/channel/groupId, so
  // the assertions hold whatever else this database already had provisioned.
  const expectedTeamName = `${course.name} — ${cohort.name}`; // teamsProvisioning.js's teamNameFor(), reproduced — short enough here to never hit its 120-char truncation
  const ourCreateTeamLines = readJournal().filter((j) => j.op === "createTeam" && j.args?.displayName === expectedTeamName);
  check("the journal recorded creating THIS cohort's Team, exactly once", ourCreateTeamLines.length === 1, `${ourCreateTeamLines.length}`);

  const ourCreateChannelLines = readJournal().filter((j) => j.op === "createChannel" && j.args?.groupId === cohortTeam1?.groupId);
  check("...and THIS Team's one channel, exactly once", ourCreateChannelLines.length === 1, `${ourCreateChannelLines.length}`);

  const ownerAdds = readJournal().filter((j) => j.op === "addTeamMember" && j.args?.groupId === cohortTeam1?.groupId && j.args?.owner === true);
  check("the teacher was added as owner of THIS Team, exactly once", ownerAdds.length === 1, `${ownerAdds.length}`);
  const memberAdds = readJournal().filter((j) => j.op === "addTeamMember" && j.args?.groupId === cohortTeam1?.groupId && j.args?.owner === false);
  check("both resolvable students were added as members of THIS Team — never the unresolved third",
    memberAdds.length === 2, `${memberAdds.length}`);

  const runsAfterProv1 = await call("/teams-automation/runs", { token: adminToken });
  const latestProvisioningRun = (runsAfterProv1.data?.runs || []).find((r) => r.job === "provisioning");
  check("the run log carries a provisioning row", latestProvisioningRun?.job === "provisioning", JSON.stringify(latestProvisioningRun));

  /* ====================================================================== */
  console.log("\n--- scenario 8: provisioning idempotence — never a second Team, never a second channel ---");
  /* ====================================================================== */

  const prov2 = await call("/teams-automation/run-provisioning", { method: "POST", token: adminToken });
  check("the second provisioning run answers 200", prov2.status === 200, `HTTP ${prov2.status}`);
  // These two ARE exact institution-wide totals, unlike run1's — every published cohort
  // that needed a Team got one on run1 (whichever cohort it was), so a run2 against the
  // same unchanged timetable creates zero new Teams and zero new channels anywhere, not
  // only for this suite's own cohort.
  check("it created no second Team, anywhere", prov2.data?.summary?.teamsCreated === 0, JSON.stringify(prov2.data?.summary));
  check("...nor a second channel, anywhere", prov2.data?.summary?.channelsCreated === 0, JSON.stringify(prov2.data?.summary));
  check("the journal gained no second createTeam for THIS cohort",
    readJournal().filter((j) => j.op === "createTeam" && j.args?.displayName === expectedTeamName).length === 1, "");
  check("...nor a second createChannel for THIS Team",
    readJournal().filter((j) => j.op === "createChannel" && j.args?.groupId === cohortTeam1?.groupId).length === 1, "");

  const cohortTeam2 = await db.cohortTeam.findMany({ where: { cohortId: cohort.id } });
  check("exactly one CohortTeam row still exists — additive-only means updated, never duplicated", cohortTeam2.length === 1, `${cohortTeam2.length}`);
  const unitChannels2 = await db.unitChannel.findMany({ where: { cohortTeamId: cohortTeam1?.id } });
  check("...and exactly one UnitChannel row", unitChannels2.length === 1, `${unitChannels2.length}`);

  /* ====================================================================== */
  console.log("\n--- scenario 9: the unit's own channel email is invited to a new meeting for it ---");
  // Provisioning (scenario 7) fetched and cached THIS channel's own address via the
  // fixtures.channelEmails map above. That alone only proves the address landed in
  // UnitChannel.channelEmail — teamsMeetings.js's channelEmailsFor() has to be the one
  // that actually reads it back and hands it to createClassMeeting as an attendee, for
  // the same cohort+unit shape (exactly one cohort group, a real unitId) its own
  // comment requires. A fresh event is needed rather than reusing A or B: A is
  // cancelled and unpublished, and B's pasted link means it never calls
  // createClassMeeting at all.
  /* ====================================================================== */

  const titleC = `Teams Automation Channel Invite ${RUN}`;
  const createdC = await call("/timetabling/events", {
    method: "POST", token: adminToken,
    body: {
      date: D7, start: T_C.start, end: T_C.end, title: titleC,
      unitId: unit.id, courseId: course.id, cohortIds: [cohort.id], staffIds: [teacher.id],
      published: true, teamsAutoMeeting: true,
    },
  });
  check("event C is created", createdC.status === 201, `HTTP ${createdC.status} ${JSON.stringify(createdC.data)}`);
  const eventCId = createdC.data?.event?.id;
  made.events.push(eventCId);

  const sync6 = await call("/teams-automation/run-meetings", { method: "POST", token: adminToken });
  check("the sixth meetings sync answers 200", sync6.status === 200, `HTTP ${sync6.status} ${sync6.data?.error || ""}`);
  check("it created exactly one new meeting — event C, the only event still wanting one it doesn't already have",
    sync6.data?.summary?.meetingsCreated === 1, JSON.stringify(sync6.data?.summary));

  const createLinesC = readJournal().filter((j) => j.op === "createClassMeeting" && j.args?.subject === titleC);
  check("the journal recorded creating event C's meeting, exactly once", createLinesC.length === 1, `${createLinesC.length}`);
  check("...addressed to the unit's own channel, not just the teacher — the channel-email invite actually fired",
    (createLinesC[0]?.args?.attendeeEmails || []).includes(CHANNEL_EMAIL), JSON.stringify(createLinesC[0]?.args?.attendeeEmails));

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

// The same fixture-id derivation teamsGraph.js uses for its own fixture branches
// (createClassMeeting, createTeam, createChannel) — duplicated rather than imported
// because it is four lines of pure string logic and importing a CommonJS internal into
// an ESM smoke suite for one helper is the worse coupling. slug() itself is not part of
// the module's public surface (module.exports never names it), so there is no export to
// import in the first place.
function slugify(s) {
  return String(s || "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
