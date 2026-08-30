// In-process scheduler for the automated daily student/staff emails.
//
// No external cron service is needed. It wakes hourly and, once a day at the configured
// send hour, runs the three notification jobs (birthdays, bank-holiday closures and
// assessment-deadline reminders). Every send is de-duplicated inside notifications.js on a
// stable key, so a restart mid-morning — or the scheduler ticking more than once within the
// send hour — can never double-send. Mirrors attendanceScheduler.js.
const clock = require("./clock");

const SEND_HOUR = 8; // 08:00 local time

async function tick() {
  // The organisation's wall clock (Europe/London), not the host's. This read
  // `new Date().getHours()`, which on Render — and on every host that runs UTC — is
  // the UTC hour, so through BST the "08:00" student and staff emails actually went
  // out at 09:00 London and the comment above was a lie for half the year. Same
  // treatment as attendanceScheduler.js: clock.localTime() is "HH:MM" in the zone.
  const londonHour = Number(clock.localTime().slice(0, 2));
  if (londonHour !== SEND_HOUR) return; // only act during the send hour
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
  // One institution per deployment, so this simply runs. See attendanceScheduler.js
  // for what the per-tenant wrapper used to do and why it is gone.
  const runAll = () => tick()
    .catch((e) => console.error("[notifications-scheduler] failed:", e.message));
  setInterval(runAll, 60 * 60 * 1000); // hourly
  setTimeout(runAll, 30 * 1000);       // and once ~30s after boot, in case we start in the send hour
  console.log(`[notifications-scheduler] started — daily student/staff emails at ${String(SEND_HOUR).padStart(2, "0")}:00`);
}

module.exports = { start, tick };
