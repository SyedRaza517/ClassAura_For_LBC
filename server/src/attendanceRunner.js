// Automated monthly attendance emails — config persistence + the monthly run.
//
// This sits between the compute/send core (attendanceEmailService.js) and its two
// callers: the admin routes (routes/attendanceEmails.js) and the in-process scheduler
// (attendanceScheduler.js). It owns the single AttendanceEmailConfig row (the editable
// templates, institution values and automation settings) and the once-a-month send,
// which is de-duplicated on a YYYY-MM period so a restart on the last day of the month
// can never double-send.
const prisma = require("./db");
const bands = require("./attendanceBands");
const service = require("./attendanceEmailService");
const email = require("./email");
const mailFrom = require("./mailFrom");

const CONFIG_ID = "singleton";

// Merge a stored config blob over the code defaults so callers always receive a complete
// config (every band template present, every institution value present).
function resolveConfig(data) {
  const d = data || {};
  const templates = {};
  for (const b of bands.BANDS) {
    const saved = d.templates && d.templates[b.key];
    const def = bands.DEFAULT_TEMPLATES[b.key] || { subject: "", body: "" };
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
    templates,
  };
}

async function loadConfig() {
  const row = await prisma.attendanceEmailConfig.findFirst({ where: { id: CONFIG_ID } }).catch(() => null);
  return resolveConfig(row && row.data);
}

// Shallow-merge the patch over the stored blob; `values` and `templates` merge one level
// deeper so saving one band's template (or one value) doesn't wipe the others.
async function saveConfig(patch = {}) {
  const row = await prisma.attendanceEmailConfig.findFirst({ where: { id: CONFIG_ID } }).catch(() => null);
  const cur = (row && row.data) || {};
  const next = { ...cur, ...patch };
  if (patch.values) next.values = { ...(cur.values || {}), ...patch.values };
  if (patch.templates) next.templates = { ...(cur.templates || {}), ...patch.templates };
  // findFirst + create/update rather than upsert: the primary key is [tenantId, id]
  // now, so { id } alone is not a selector Prisma accepts. The scoped read also means
  // each institution finds only its OWN row — which is the bug this replaced, where
  // every tenant fought over one literal "singleton" id and only the first could save.
  const own = await prisma.attendanceEmailConfig.findFirst({ where: { id: CONFIG_ID } });
  if (own) await prisma.attendanceEmailConfig.updateMany({ where: { id: CONFIG_ID }, data: { data: next } });
  else await prisma.attendanceEmailConfig.create({ data: { id: CONFIG_ID, data: next } });
  return resolveConfig(next);
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
async function runMonthly({ force = false, from = null, to = null } = {}) {
  const custom = from && to ? service.termFromRange(from, to) : null;
  const term = custom || await service.currentTerm();
  if (!term) return { ok: false, reason: "no-current-term" };

  const now = new Date();
  const period = ymPeriod(now);
  const config = await loadConfig();
  // The once-a-month de-dupe only guards the automatic current-term run.
  if (!custom && !force && config.lastRunPeriod === period) return { ok: false, reason: "already-run", period };

  const { period: periodLabel, students } = await service.computeCurrentTermAttendance(term);
  const respondByDate = fmtDate(addWorkingDays(now, config.respondDays));
  const summary = await service.sendToStudents(students, config, { period: periodLabel, respondByDate });

  // Only the current-term run advances the month marker; a custom range must not mark the
  // current month as "already sent".
  if (!custom) await saveConfig({ lastRunPeriod: period });
  return { ok: true, period: custom ? periodLabel : period, term: term.name, custom: !!custom, ...summary };
}

// Send ONE student their band email right now (the per-student send from the tab). Uses the
// same freshly-computed figures + band template as the bulk run — over the current term, or
// over an admin-chosen { from, to } range when the date picker is set.
async function sendOneStudent(studentId, { from = null, to = null } = {}) {
  const custom = from && to ? service.termFromRange(from, to) : null;
  const term = custom || await service.currentTerm();
  if (!term) return { ok: false, reason: "no-current-term" };
  const { period, students } = await service.computeCurrentTermAttendance(term);
  const student = students.find((s) => s.id === studentId);
  if (!student) return { ok: false, reason: "not-found" };
  if (!student.email) return { ok: false, reason: "no-email" };
  if (!student.bandKey) return { ok: false, reason: "no-attendance" };

  const config = await loadConfig();
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
