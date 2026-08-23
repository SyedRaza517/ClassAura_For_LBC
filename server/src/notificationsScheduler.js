// In-process scheduler for the automated daily student/staff emails.
//
// No external cron service is needed. It wakes hourly and, once a day at the configured
// send hour, runs the three notification jobs (birthdays, bank-holiday closures and
// assessment-deadline reminders). Every send is de-duplicated inside notifications.js on a
// stable key, so a restart mid-morning — or the scheduler ticking more than once within the
// send hour — can never double-send. Mirrors attendanceScheduler.js.
const SEND_HOUR = 8; // 08:00 local time

async function tick() {
  const now = new Date();
  if (now.getHours() !== SEND_HOUR) return; // only act during the send hour
  try {
    // Required lazily so the scheduler can start before the jobs module (and Prisma) is touched.
    const out = await require("./notifications").runDaily();
    const b = out.birthdays || {};
    const h = out.bankHolidays || {};
    const a = out.assessments || {};
    console.log(
      `[notifications-scheduler] birthdays ${b.sent || 0} sent/${b.skipped || 0} skipped · ` +
      `bank-holiday ${h.sent || 0} sent/${h.skipped || 0} skipped${h.holiday ? ` (${h.holiday})` : ""} · ` +
      `assessments ${a.sent || 0} sent/${a.skipped || 0} skipped`
    );
  } catch (e) {
    console.error("[notifications-scheduler]", e && e.message ? e.message : e);
  }
}

function start() {
  // Per institution — each has its own staff, students and send hour. See eachTenant.js.
  const { forEachTenant } = require("./eachTenant");
  const runAll = () => forEachTenant("daily-notifications", () => tick())
    .catch((e) => console.error("[notifications-scheduler] failed:", e.message));
  setInterval(runAll, 60 * 60 * 1000); // hourly
  setTimeout(runAll, 30 * 1000);       // and once ~30s after boot, in case we start in the send hour
  console.log(`[notifications-scheduler] started — daily student/staff emails at ${String(SEND_HOUR).padStart(2, "0")}:00`);
}

module.exports = { start, tick };
