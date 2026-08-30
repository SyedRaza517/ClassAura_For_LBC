// In-process scheduler for the automated month-end attendance emails.
//
// No external cron service is needed. It wakes hourly and, only when automation is
// switched on, sends the banded attendance emails on the LAST calendar day of each month
// at/after the configured hour. The actual send is de-duplicated on the YYYY-MM period in
// attendanceRunner.runMonthly, so a restart mid-day (or an extra tick) can't double-send.
// Everything is gated by config: with automation off (the default) this does nothing.
const runner = require("./attendanceRunner");
const clock = require("./clock");

// True when `d` is the last day of its month (tomorrow rolls into a new month).
function isLastDayOfMonth(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return t.getMonth() !== d.getMonth();
}

async function tick() {
  try {
    const config = await runner.loadConfig();
    if (!config.autoEnabled) return;
    // Evaluate the schedule on the organisation's wall clock (Europe/London), not the
    // host's (Render/most hosts run UTC): clock.localDate() → "YYYY-MM-DD", clock.localTime()
    // → "HH:MM". Build a plain Date from the London Y/M/D purely for the calendar arithmetic
    // in isLastDayOfMonth (timezone-independent), and read the London hour off localTime().
    const [ly, lm, ld] = clock.localDate().split("-").map(Number);
    const londonDay = new Date(ly, lm - 1, ld);
    const londonHour = Number(clock.localTime().slice(0, 2));
    if (!isLastDayOfMonth(londonDay)) return;
    if (londonHour < (config.sendHour != null ? config.sendHour : 9)) return;
    const out = await runner.runMonthly({ force: false }); // de-dupe handled inside
    if (out.ok) {
      console.log(`[attendance-scheduler] ${out.period}: ${out.sent} sent, ${out.failed} failed, ${out.skipped} skipped`);
    } else if (out.reason === "email-off") {
      // Loud, because this is the one failure nobody would otherwise notice: the month's
      // letters went to the console and every student is still waiting for theirs.
      console.error(`[attendance-scheduler] ${out.period}: NOTHING SENT — no mailer is configured (${out.stubbed} email(s) printed to the console). Set RESEND_API_KEY or the SMTP_* variables.`);
    }
  } catch (e) {
    console.error("[attendance-scheduler]", e && e.message ? e.message : e);
  }
}

function start() {
  // Ran once per institution until this deployment served exactly one. The wrapper
  // that did it (eachTenant.js) existed because a job on a timer is outside any
  // request, so nothing had resolved a tenant for it and every query would throw.
  // With one institution there is nothing to resolve and nothing to iterate; the
  // .catch below already does the error isolation the wrapper also provided.
  const runAll = () => tick()
    .catch((e) => console.error("[attendance-scheduler] failed:", e.message));
  setInterval(runAll, 60 * 60 * 1000); // hourly
  setTimeout(runAll, 30 * 1000);       // and once ~30s after boot, in case we start on month-end
  console.log("[attendance-scheduler] started — month-end attendance emails (enable in the Attendance Emails tab)");
}

module.exports = { start, tick, isLastDayOfMonth };
