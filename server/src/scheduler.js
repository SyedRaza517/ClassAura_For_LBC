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
  // Runs inside forEachTenant (see startScheduler), so this reads the right
  // institution's row without being told which.
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

// Kick off the background scheduler. Hourly cadence; the guards inside each job
// limit real work to its own day/hour. unref() so the timer never keeps the process
// alive on its own.
function startScheduler() {
  // Once per institution. These run on a timer, outside any request, so nothing has
  // resolved a tenant for them — see eachTenant.js. One college failing must not stop
  // the rest, which forEachTenant guarantees.
  const { forEachTenant } = require("./eachTenant");
  const run = () => {
    forEachTenant("timesheet-reminders", () => sendTimesheetReminders())
      .catch((e) => console.error("scheduler run failed:", e.message));
    // Kept separate so a failing Moodle import can never stop the reminders.
    forEachTenant("moodle-import", () => maybeSyncMoodle())
      .catch((e) => console.error("nightly Moodle import failed:", e.message));
  };
  run(); // run once on boot (covers a deploy that happens on the reminder day)
  setInterval(run, 60 * 60 * 1000).unref();
  console.log(`Scheduler: timesheet month-end reminders active (checks hourly); Moodle import at ${SYNC_HOUR}:00`);
}

module.exports = { startScheduler, sendTimesheetReminders, maybeSyncMoodle, isDayBeforeMonthEnd, lastDayOfMonth };
