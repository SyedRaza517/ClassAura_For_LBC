// Scheduled reminders.
//
// Currently: nudge staff to send their monthly timesheet the day BEFORE the month
// ends, so the office has every timesheet in hand for approval before month close.
//
// Design: run hourly, but a date guard means real reminders only go out on the
// reminder day. A per-staff, same-day dedupe (checked against the notifications
// table, not just memory) makes the job safe to run repeatedly and to survive a
// process restart on the host — a staff member is reminded at most once per day.
const prisma = require("./db");
const { localDate, localTime } = require("./clock");
const { notifyStaff } = require("./notify");

// The reminder's own link, distinct from the "timesheet" link that review outcomes
// use, so the dedupe below can tell its own notifications from anybody else's. The
// staff app treats any link starting "timesheet" as the timesheet screen.
const REMINDER_LINK = "timesheet:reminder";

// Last calendar day of the month that `dateStr` (YYYY-MM-DD) falls in.
function lastDayOfMonth(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  return new Date(y, m, 0).getDate(); // day 0 of the next month = last day of this one
}

// True when `dateStr` is exactly one day before its month ends.
function isDayBeforeMonthEnd(dateStr) {
  return Number(dateStr.slice(8, 10)) === lastDayOfMonth(dateStr) - 1;
}

// Send the reminder to every staff member who hasn't sent this month's timesheet.
// `todayOverride` (YYYY-MM-DD) exists only for tests; production passes nothing.
async function sendTimesheetReminders(todayOverride) {
  const today = todayOverride || localDate();  // London YYYY-MM-DD
  if (!isDayBeforeMonthEnd(today)) return 0;    // only the reminder day does anything
  const month = today.slice(0, 7);
  const monthName = new Date(month + "-01T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  // Dedupe window: this reminder only ever fires on ONE day per month, so any
  // timesheet reminder created in the last 2 days must be from today's run(s).
  // Using real elapsed time (not a date-string boundary) makes the hourly re-runs
  // idempotent and survives a host restart, without the London-midnight/UTC edge.
  const recentCutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  // Not `accountRole: "STAFF"` — being granted any single admin page flips an account
  // to ADMIN, so a lecturer who also manages one dashboard section stopped receiving
  // timesheet reminders entirely, for ever. Everyone who can file a timesheet gets one.
  const staff = await prisma.staff.findMany({
    where: { pendingActivation: false },
    select: { id: true },
  });

  let sent = 0;
  for (const s of staff) {
    // Already sent this month's timesheet → nothing to remind them about.
    const submitted = await prisma.timesheetEntry.count({ where: { staffId: s.id, status: "submitted", date: { startsWith: month } } });
    if (submitted > 0) continue;
    // Already reminded in this run window → skip (no double-send).
    // Matched on the reminder's OWN link, not the shared "timesheet" one. The review
    // outcomes ("approved" / "needs changes") also use link:"timesheet", so a staff
    // member whose timesheet was bounced back yesterday matched this dedupe and was
    // skipped — the one person who provably had an unsent timesheet was the one person
    // never reminded to send it.
    const already = await prisma.notification.count({ where: { staffId: s.id, link: REMINDER_LINK, createdAt: { gte: recentCutoff } } });
    if (already > 0) continue;
    await notifyStaff(s.id, {
      type: "info",
      message: `Reminder: please send your ${monthName} timesheet before the month ends so it can be approved.`,
      link: REMINDER_LINK,
    });
    sent++;
  }
  if (sent > 0) console.log(`Timesheet reminders sent to ${sent} staff for ${month}`);
  return sent;
}

// Overnight Moodle import, so marks entered in the VLE during the day are in Staff
// Hub by morning without anyone pressing anything.
//
// Runs at 02:00 London — quiet for both systems. The hourly tick means the guard
// below decides whether this hour is the one; the 12-hour dedupe against the
// MoodleSync table then makes a restart (or a second tick inside the same hour)
// harmless. Each institution switches its own nightly import on or off under
// Settings -> Connected systems; MOODLE_AUTO_SYNC=off is the server-wide default
// for a deployment where nobody has saved that preference.
const SYNC_HOUR = "02";

async function maybeSyncMoodle() {
  const moodle = require("./moodle");
  // Whose switch decides this.
  //
  // TenantIntegration.autoSync was saved by the Settings screen and then read by
  // nothing: the only gate was the process-wide MOODLE_AUTO_SYNC, so a college that
  // turned its own nightly import OFF kept being imported anyway, and one that turned
  // it ON got nothing if the server-wide variable said "off". The institution's own
  // choice now wins, and the environment variable is what remains for a
  // single-institution deployment that has saved nothing.
  //
  // Reads this deployment's own configuration row; there is only one.
  const cfg = require("./integrationConfig");
  await cfg.load("moodle");
  const autoSync = cfg.peek("moodle").autoSync;
  const off = (v) => String(v ?? "").toLowerCase() === "off" || v === false || String(v) === "false";
  if (autoSync !== undefined && autoSync !== "" ? off(autoSync) : off(process.env.MOODLE_AUTO_SYNC)) return false;
  if (!moodle.isConfigured() || moodle.isRunning()) return false;
  if (localTime().slice(0, 2) !== SYNC_HOUR) return false;

  // Resolve abandoned runs BEFORE the dedupe below counts them: a ghost "running" row
  // otherwise counts as "tonight's run already happened" and the import is skipped
  // entirely. Shared with GET /moodle/status — the sweep and its threshold live in
  // ./moodle, rather than being spelled out identically in both callers.
  await moodle.sweepStaleRuns();

  const recent = await prisma.moodleSync.count({
    where: {
      mode: "scheduled",
      // A run that never finished is not a run that happened.
      status: { in: ["ok", "failed"] },
      startedAt: { gte: new Date(Date.now() - 12 * 60 * 60 * 1000) },
    },
  });
  if (recent > 0) return false; // tonight's run already happened

  console.log("Scheduler: starting the nightly Moodle import");
  const { summary } = await moodle.runSync({ mode: "scheduled" });
  console.log(`Scheduler: Moodle import finished — ${summary.gradesCreated} new mark(s), ${summary.gradesUpdated} updated`);
  return true;
}

// The Teams attendance poller. Unlike the Moodle import it runs at EVERY hourly tick
// rather than a fixed hour, because its work is "sessions that ended since last
// look" — naturally incremental, and cheap when there are none. The switch is the
// college's own (TeamsAttendanceConfig.enabled, shipped false); isConfigured() also
// gates it, so an enabled switch with no credentials does nothing rather than erroring
// hourly. Dedupe: the engine's own in-process lock plus a 30-minute window against
// the run log, so a restart inside the hour cannot double-run.
async function maybeSyncTeamsAttendance() {
  const teamsGraph = require("./teamsGraph");
  const teamsConfig = require("./teamsAttendanceConfig");
  const teamsSync = require("./teamsSync");
  const cfg = require("./integrationConfig");
  await cfg.load("teams");
  const settings = await teamsConfig.get();
  if (!settings.enabled) return false;
  if (!teamsGraph.isConfigured() || teamsSync.isRunning()) return false;
  await teamsSync.sweepStaleRuns();
  const recent = await prisma.teamsSync.count({
    where: { mode: "scheduled", status: { in: ["ok", "failed"] }, startedAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
  });
  if (recent > 0) return false;
  console.log("Scheduler: starting the Teams attendance sync");
  const { summary } = await teamsSync.runSync({ mode: "scheduled" });
  console.log(`Scheduler: Teams attendance sync finished — ${summary.marksCreated} mark(s) written, ${summary.reportsFetched} report(s) read`);
  return true;
}

// The Teams MEETINGS poller (Phase A of Teams automation, distinct from the
// attendance sync above). Runs at every hourly tick, the same as
// maybeSyncTeamsAttendance, because its work is "events whose publish state or
// content changed since we last looked" — naturally incremental, and cheap when
// there are none, so there is nothing an overnight-only cadence would buy. Gated on
// TeamsAutomationConfig.autoCreateMeetings (constraints.md: both switches default
// false, off means no Graph calls at all) AND graph.isConfigured(), so a switch
// flipped on with no Teams credentials yet saved does nothing rather than erroring
// every hour. Dedupe: the engine's own in-process lock plus a 30-minute window
// against TeamsProvisionSync, same shape as the attendance sync's own dedupe.
async function maybeRunTeamsMeetings() {
  const teamsGraph = require("./teamsGraph");
  const teamsAutomationConfig = require("./teamsAutomationConfig");
  const teamsMeetings = require("./teamsMeetings");
  const cfg = require("./integrationConfig");
  await cfg.load("teams");
  const settings = await teamsAutomationConfig.get();
  if (!settings.autoCreateMeetings) return false;
  if (!teamsGraph.isConfigured() || teamsMeetings.isRunning()) return false;
  await teamsMeetings.sweepStaleRuns();
  const recent = await prisma.teamsProvisionSync.count({
    where: { job: "meetings", mode: "scheduled", status: { in: ["ok", "failed"] }, startedAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
  });
  if (recent > 0) return false;
  console.log("Scheduler: starting the Teams meetings sync");
  const { summary } = await teamsMeetings.runMeetingsSync({ mode: "scheduled" });
  console.log(`Scheduler: Teams meetings sync finished — ${summary.meetingsCreated} created, ${summary.meetingsUpdated} updated, ${summary.meetingsCancelled} cancelled`);
  return true;
}

// The Teams PROVISIONING sweep (Phase B: Teams + channels + membership for every
// cohort with a published timetable). NIGHTLY, unlike the two hourly jobs above —
// same reasoning as maybeSyncMoodle's own SYNC_HOUR guard: this touches every cohort,
// every unit and every student in the college on each run, so an hourly cadence would
// buy nothing a nightly one does not (nobody's roster changes fast enough for that)
// while making every Graph rate limit and every stray "already a member" 400 in the
// journal an hourly event instead of a nightly one. Also always available manually
// (the route this feature's routes/teamsAutomation.js exposes), for a college that
// wants its first provisioning run to happen the moment it switches the setting on
// rather than waiting for 02:00.
//
// Guarded on SYNC_HOUR — the SAME "02" hour Moodle's import uses — rather than a
// literal 02:30 window. Ticks fire every 60 minutes from whatever minute the process
// booted at (startScheduler below), never realigned to the wall clock, so a guard
// that demanded minutes 30-59 specifically would only ever fire on nights where the
// boot offset happened to land there — for most deployments, never. An hour-band
// compare (matching Moodle's own) instead fires reliably once every 24 hours,
// whatever the boot offset, which is what "runs once a night" actually requires;
// running in the same tick as the Moodle import costs nothing since each guard is its
// own statement with its own try/catch, and the two jobs dedupe against entirely
// separate tables (TeamsProvisionSync vs MoodleSync) so neither can suppress the
// other's run.
async function maybeRunTeamsProvisioning() {
  const teamsGraph = require("./teamsGraph");
  const teamsAutomationConfig = require("./teamsAutomationConfig");
  const teamsProvisioning = require("./teamsProvisioning");
  const cfg = require("./integrationConfig");
  await cfg.load("teams");
  const settings = await teamsAutomationConfig.get();
  if (!settings.provisionTeams) return false;
  if (!teamsGraph.isConfigured() || teamsProvisioning.isRunning()) return false;
  if (localTime().slice(0, 2) !== SYNC_HOUR) return false;
  await teamsProvisioning.sweepStaleRuns();
  const recent = await prisma.teamsProvisionSync.count({
    where: { job: "provisioning", mode: "scheduled", status: { in: ["ok", "failed"] }, startedAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
  });
  if (recent > 0) return false; // tonight's run already happened
  console.log("Scheduler: starting the nightly Teams provisioning sync");
  const { summary } = await teamsProvisioning.runProvisioning({ mode: "scheduled" });
  console.log(`Scheduler: Teams provisioning sync finished — ${summary.teamsCreated} team(s), ${summary.channelsCreated} channel(s), ${summary.ownersAdded} owner(s), ${summary.membersAdded} member(s) added`);
  return true;
}

// Kick off the background scheduler. Hourly cadence; the guards inside each job
// limit real work to its own day/hour. unref() so the timer never keeps the process
// alive on its own.
function startScheduler() {
  // One institution per deployment, so these simply run. They used to be wrapped
  // once per tenant by eachTenant.js, which is gone — see attendanceScheduler.js.
  const run = () => {
    sendTimesheetReminders()
      .catch((e) => console.error("scheduler run failed:", e.message));
    // Still two statements rather than one chain: a failing Moodle import must never
    // stop the reminders, which is why they were separate calls before too.
    maybeSyncMoodle()
      .catch((e) => console.error("nightly Moodle import failed:", e.message));
    // Same reasoning again: a failing Teams sync must never stop the reminders or the
    // Moodle import either, so it is its own statement rather than chained onto them.
    maybeSyncTeamsAttendance()
      .catch((e) => console.error("Teams attendance sync failed:", e.message));
    // Same reasoning again, for the two Teams AUTOMATION jobs (meetings, provisioning)
    // added alongside the attendance sync above — each its own statement so that one
    // failing job (a bad Graph credential, a stuck provisioning operation) never stops
    // any of the others, including each other.
    maybeRunTeamsMeetings()
      .catch((e) => console.error("Teams meetings sync failed:", e.message));
    maybeRunTeamsProvisioning()
      .catch((e) => console.error("Teams provisioning sync failed:", e.message));
  };
  run(); // run once on boot (covers a deploy that happens on the reminder day)
  setInterval(run, 60 * 60 * 1000).unref();
  // Names every scheduled job — a prior review flagged that this line went stale
  // (only naming reminders + Moodle) each time a new job was added beside them.
  console.log(`Scheduler: timesheet month-end reminders active (checks hourly); Moodle import at ${SYNC_HOUR}:00; Teams attendance sync hourly; Teams meetings sync hourly; Teams provisioning sync nightly (${SYNC_HOUR}:00 hour)`);
}

module.exports = {
  startScheduler, sendTimesheetReminders, maybeSyncMoodle, maybeSyncTeamsAttendance,
  maybeRunTeamsMeetings, maybeRunTeamsProvisioning, isDayBeforeMonthEnd, lastDayOfMonth,
};
