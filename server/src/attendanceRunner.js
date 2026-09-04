// Automated monthly attendance emails — config persistence + the monthly run.
//
// This sits between the compute/send core (attendanceEmailService.js) and its two
// callers: the admin routes (routes/attendanceEmails.js) and the in-process scheduler
// (attendanceScheduler.js). It owns the single AttendanceEmailConfig row (the editable
// templates, institution values and automation settings) and the once-a-month send,
// which is de-duplicated on a YYYY-MM period so a restart on the last day of the month
// can never double-send.
const prisma = require("./db");
const { withoutAcademicScope } = require("./academicScope");
const bands = require("./attendanceBands");
const bandConfig = require("./attendanceBandConfig");
const service = require("./attendanceEmailService");
const email = require("./email");
const mailFrom = require("./mailFrom");

const CONFIG_ID = "singleton";

// Merge a stored config blob over the code defaults so callers always receive a complete
// config (every band template present, every institution value present).
//
// `bandList` is this college's configured ladder, so the templates returned are exactly
// one per band it actually uses — a band it invented gets the generic starting letter
// rather than nothing, and a band it deleted stops appearing in the editor. It defaults
// to the built-in bands so this function stays synchronous and callable without a
// database, which is what lets the route and the scheduler share it.
function resolveConfig(data, bandList) {
  const d = data || {};
  const list = Array.isArray(bandList) && bandList.length ? bandList : bands.DEFAULT_BANDS;
  const templates = {};
  for (const b of list) {
    const saved = d.templates && d.templates[b.key];
    const def = bands.templateForKey(b.key);
    templates[b.key] = {
      subject: saved && saved.subject != null ? saved.subject : def.subject,
      body: saved && saved.body != null ? saved.body : def.body,
    };
  }
  return {
    autoEnabled: !!d.autoEnabled,
    respondDays: Number.isFinite(d.respondDays) ? d.respondDays : 5,
    sendHour: Number.isFinite(d.sendHour) ? d.sendHour : 9,
    lastRunPeriod: d.lastRunPeriod || null,
    values: { ...bands.DEFAULT_VALUES, ...(d.values || {}) },
    // The ladder itself travels WITH the templates. Every caller that has a config also
    // has the bands those templates belong to, so none of them has to re-resolve the
    // ladder and risk pairing a letter with a threshold that has since been edited.
    bands: list,
    templates,
  };
}

async function loadConfig() {
  const [row, list] = await Promise.all([
    prisma.attendanceEmailConfig.findUnique({ where: { id: CONFIG_ID } }).catch(() => null),
    bandConfig.get(),
  ]);
  return resolveConfig(row && row.data, list);
}

// Shallow-merge the patch over the stored blob; `values` and `templates` merge one level
// deeper so saving one band's template (or one value) doesn't wipe the others.
async function saveConfig(patch = {}) {
  const row = await prisma.attendanceEmailConfig.findUnique({ where: { id: CONFIG_ID } }).catch(() => null);
  const cur = (row && row.data) || {};
  const next = { ...cur, ...patch };
  if (patch.values) next.values = { ...(cur.values || {}), ...patch.values };
  if (patch.templates) next.templates = { ...(cur.templates || {}), ...patch.templates };
  // One upsert on the constant key. This was briefly a findFirst + create/update pair,
  // because the primary key had become [tenantId, id] and `{ id }` alone was no longer
  // a selector Prisma would accept. `id` is the whole primary key again, so the atomic
  // form is available and is the one to use: find-then-create is two statements, and
  // two ticks of the scheduler racing on the first ever save would both find nothing,
  // both create, and leave two rows — after which loadConfig reads an arbitrary one and
  // the month marker written by the other never stops a second send.
  await prisma.attendanceEmailConfig.upsert({
    where: { id: CONFIG_ID },
    update: { data: next },
    create: { id: CONFIG_ID, data: next },
  });
  // Resolved against the college's real ladder, not the code defaults: saving a
  // template must not hand the caller back a config describing six bands when this
  // college runs three. Bands themselves are NOT written here — they live in their own
  // table and are saved through attendanceBandConfig, because this blob is
  // shallow-merged and a merge cannot express "one fewer band than before".
  return resolveConfig(next, await bandConfig.get());
}

// The date `n` working days (Mon–Fri) ahead of `from`, for the "respond by" line.
function addWorkingDays(from, n) {
  const d = new Date(from);
  let added = 0;
  while (added < n) { d.setDate(d.getDate() + 1); const wd = d.getDay(); if (wd !== 0 && wd !== 6) added++; }
  return d;
}
const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MO = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmtDate = (d) => `${WD[d.getDay()]}, ${d.getDate()} ${MO[d.getMonth()]} ${d.getFullYear()}`;
const ymPeriod = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

// Send the banded emails to every current student. Normally over the current term, but an
// admin-chosen { from, to } range (from the tab's date picker) computes over any period
// instead. De-duplicates the AUTOMATIC current-term run on the YYYY-MM period (skips if
// already run this month) unless `force`; a custom range is always a manual, forced send
// and never touches the month marker. Returns { ok, reason?, period, term, custom, sent, ... }.
//
// A run that reached an unconfigured mailer comes back ok:false / reason:"email-off" — see
// the comment at the send below.
/**
 * The monthly attendance letters.
 *
 * INSTITUTION-WIDE: one run over the whole college's registers, fired by a scheduler that
 * has no caller and therefore no department. Declared here rather than in
 * attendanceScheduler.js so that a hand-triggered run is covered by the same statement --
 * a monthly letter run is a college-wide job whoever starts it.
 */
async function runMonthly(opts = {}) {
  return withoutAcademicScope(
    "attendance letters: one monthly run across the whole college's registers",
    () => runMonthlyInner(opts),
  );
}

async function runMonthlyInner({ force = false, from = null, to = null } = {}) {
  const now = new Date();
  const period = ymPeriod(now);
  const config = await loadConfig();

  // Checked FIRST, before the term is even resolved. Not one band on this college's
  // ladder sends a letter, so this run would email nobody whatever the term turned out
  // to be — and reporting "no teaching term" to someone who has simply switched every
  // trigger off sends them to fix the registers instead of the checkbox they just
  // unticked. It is also the cheapest of the three preconditions.
  if (!config.bands.some((b) => b.emailTrigger)) {
    return { ok: false, reason: "no-email-bands", period: from && to ? null : period };
  }

  const custom = from && to ? service.termFromRange(from, to) : null;
  const term = custom || await service.currentTerm();
  if (!term) return { ok: false, reason: "no-current-term" };

  // The once-a-month de-dupe only guards the automatic current-term run.
  if (!custom && !force && config.lastRunPeriod === period) return { ok: false, reason: "already-run", period };

  const { period: periodLabel, students } = await service.computeCurrentTermAttendance(term, config.bands);
  const respondByDate = fmtDate(addWorkingDays(now, config.respondDays));
  const summary = await service.sendToStudents(students, config, { period: periodLabel, respondByDate });

  // A run that only printed to the console is not a run. Two things follow, and both are
  // the reason the service counts `stubbed` apart from `skipped`: the caller is told
  // plainly that email is off (it used to receive a tally of skips that read like success),
  // and the month marker is NOT advanced — otherwise the month in which someone finally
  // configures SMTP is silently skipped, because a send of nothing already claimed it.
  if (summary.stubbed > 0) {
    return { ok: false, reason: "email-off", period: custom ? periodLabel : period, term: term.name, custom: !!custom, ...summary };
  }

  // Only the current-term run advances the month marker; a custom range must not mark the
  // current month as "already sent".
  if (!custom) await saveConfig({ lastRunPeriod: period });
  return { ok: true, period: custom ? periodLabel : period, term: term.name, custom: !!custom, ...summary };
}

// Send ONE student their band email right now (the per-student send from the tab). Uses the
// same freshly-computed figures + band template as the bulk run — over the current term, or
// over an admin-chosen { from, to } range when the date picker is set.
//
// A band's emailTrigger is deliberately NOT enforced here. That flag answers "does the
// MONTH-END RUN write to this band automatically", and this path is an administrator
// looking at one named student and pressing Send. Refusing it would mean a tutor who
// wants to congratulate one student cannot, because the college chose not to automate
// that band — and the band still has a template, so there is a real letter to send.
async function sendOneStudent(studentId, { from = null, to = null } = {}) {
  const custom = from && to ? service.termFromRange(from, to) : null;
  const term = custom || await service.currentTerm();
  if (!term) return { ok: false, reason: "no-current-term" };
  const config = await loadConfig();
  const { period, students } = await service.computeCurrentTermAttendance(term, config.bands);
  const student = students.find((s) => s.id === studentId);
  if (!student) return { ok: false, reason: "not-found" };
  if (!student.email) return { ok: false, reason: "no-email" };
  if (!student.bandKey) return { ok: false, reason: "no-attendance" };

  // The institution's branding, as the bulk run already does. Without this one line
  // the single-student send from the Attendance Emails tab produced the same letter
  // with no logo, no address and no footer — the same message from two paths looking
  // like it came from two different colleges.
  config.brand = await require("./branding").get();
  const respondByDate = fmtDate(addWorkingDays(new Date(), config.respondDays));
  const built = service.buildEmailFor(student, config, { period, respondByDate });
  if (!built) return { ok: false, reason: "no-template" };

  const r = await email.sendEmail(student.email, built.subject, built.text, { html: built.html, from: await mailFrom.resolve("attendance") });
  if (r.sent) return { ok: true, student: student.name, band: student.bandLabel, email: student.email };
  return { ok: false, reason: r.stubbed ? "email-off" : "send-failed", error: r.error, student: student.name };
}

module.exports = { loadConfig, saveConfig, resolveConfig, runMonthly, sendOneStudent, ymPeriod };
