// Automated, scheduled student/staff emails — the pure "jobs" module.
//
// Three jobs run once a day (driven by notificationsScheduler.js):
//   • birthdays               — a warm greeting to students/staff whose DOB is today
//   • bank-holiday reminders  — "the college is closed tomorrow" to everyone
//   • assessment reminders    — "your assessment is due in 2 weeks" to enrolled students
//
// Every send is de-duplicated through the SentNotification ledger on a stable key, so a
// restart, a double tick, or a re-run in the same hour can never send the same mail twice.
// Sending is best-effort: email.sendEmail() never throws, and a failed job never stops the
// others (see runDaily). This module has no timers of its own — the scheduler owns those.
const prisma = require("./db");
const email = require("./email");
const bankHolidays = require("./bankHolidays");
const mailFrom = require("./mailFrom");
const mailAssets = require("./mailAssets");

// ---------------------------------------------------------------------------
// Date helpers — all UTC / string based, matching the "YYYY-MM-DD" columns used
// throughout the schema (dob, dueDate, …). Kept deliberately timezone-agnostic.
// ---------------------------------------------------------------------------

// Today as "YYYY-MM-DD".
function today() {
  return new Date().toISOString().slice(0, 10);
}

// Add (or subtract) whole days to a "YYYY-MM-DD" string, returning "YYYY-MM-DD".
function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Format a "YYYY-MM-DD" nicely, e.g. "Monday, 5 January 2026". Falls back to the raw
// string if it can't be parsed, so a bad value degrades gracefully rather than throwing.
function formatDate(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (isNaN(d)) return String(ymd);
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// First name from a free-text full name ("Jane Q. Smith" → "Jane"). Used for staff, who
// only carry a single `name`. Returns "" when there's nothing usable.
function firstNameOf(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

// ---------------------------------------------------------------------------
// De-duplication ledger (SentNotification: { key @id, sentAt }).
// ---------------------------------------------------------------------------

// Has an email with this key already been recorded as sent?
async function alreadySent(key) {
  // [tenantId, key] is the primary key now, so { key } alone is not a selector.
  const row = await prisma.sentNotification.findFirst({ where: { key } });
  return Boolean(row);
}

// Record a key as sent. A collision from two ticks racing is expected and ignored —
// the ledger only needs to end up containing the key, not who wrote it.
//
// Until the primary key became [tenantId, key], this also swallowed a very different
// failure: keys like "bankholiday:2026-12-25" are identical across institutions, so
// the SECOND tenant's write collided with the first tenant's row and was discarded
// here in silence. That tenant then had no ledger entry, lost its dedupe guarantee,
// and could send the same notification again.
async function markSent(key) {
  try {
    await prisma.sentNotification.create({ data: { key } });
  } catch (e) {
    // Already present (P2002 unique violation) or transient — safe to swallow.
  }
}

// ---------------------------------------------------------------------------
// Branded HTML.
// ---------------------------------------------------------------------------

// HTML-escape any value interpolated into an email body (names, unit titles, …).
const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// The shared branded email shell. `eyebrow` and `heading` are plain text (escaped here);
// `bodyHtml` is trusted HTML the caller has already assembled (escaping its own values).
function shell(eyebrow, heading, bodyHtml) {
  return `<div style="margin:0;padding:24px;background:#eef1f6;font-family:'Segoe UI',system-ui,-apple-system,sans-serif">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(15,23,42,.08)">
      <div style="background:linear-gradient(135deg,#1a3a8f,#9e1b32);padding:20px 24px">
        <img src="${mailAssets.logoUrl}" width="44" height="26" alt="EdTech" style="display:block;margin:0 0 10px;border:0;outline:none;max-width:44px" />
        <p style="margin:0 0 2px;color:rgba(255,255,255,.7);font-size:11px;letter-spacing:.18em">${esc(eyebrow)}</p>
        <p style="margin:0;color:#fff;font-size:18px;font-weight:800">EdTech</p>
      </div>
      <div style="padding:24px"><h1 style="margin:0 0 12px;font-size:19px;color:#0f172a">${esc(heading)}</h1><div style="font-size:14px;line-height:1.6;color:#334155">${bodyHtml}</div></div>
      <div style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0"><p style="margin:0;font-size:11px;color:#94a3b8">EdTech · 42 The Burroughs, Hendon, London NW4 4AP · info@edtech.co.uk</p></div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Job 1 — Birthdays.
// ---------------------------------------------------------------------------

// Greet every active student and non-pending staff member whose DOB (month + day) is
// today. Keyed per person per calendar year so it fires once a year, exactly once.
async function runBirthdays() {
  const t = today();
  const mmdd = t.slice(5);   // "MM-DD"
  const year = t.slice(0, 4);
  let sent = 0, skipped = 0;

  const students = await prisma.student.findMany({
    where: { active: true },
    select: { id: true, firstName: true, email: true, dob: true },
  });
  const staff = await prisma.staff.findMany({
    where: { pendingActivation: false },
    select: { id: true, name: true, email: true, dob: true },
  });

  // Build a uniform work list of { kind, id, first, email } for everyone celebrating today.
  const birthdayPeople = [];
  for (const s of students) {
    if (s.dob && s.dob.slice(5) === mmdd && s.email) {
      birthdayPeople.push({ kind: "student", id: s.id, first: s.firstName, email: s.email });
    }
  }
  for (const p of staff) {
    if (p.dob && p.dob.slice(5) === mmdd && p.email) {
      birthdayPeople.push({ kind: "staff", id: p.id, first: firstNameOf(p.name), email: p.email });
    }
  }

  for (const person of birthdayPeople) {
    const key = `birthday:${person.kind}:${person.id}:${year}`;
    if (await alreadySent(key)) { skipped++; continue; }

    const first = person.first || "there";
    const subject = `Happy Birthday, ${first}!`;
    const text =
      `Happy Birthday, ${first}!\n\n` +
      `Everyone at EdTech is wishing you a wonderful day. ` +
      `Thank you for being part of our community — we hope your year ahead is a brilliant one.\n\n` +
      `With warm wishes,\nEdTech`;
    const html = shell(
      "HAPPY BIRTHDAY",
      `Happy Birthday, ${esc(first)}!`,
      `<p style="margin:0 0 12px">Everyone at EdTech is wishing you a wonderful day. 🎉</p>
       <p style="margin:0 0 12px">Thank you for being part of our community — we hope the year ahead is a brilliant one, full of good things.</p>
       <p style="margin:0">With warm wishes,<br><strong>EdTech</strong></p>`
    );

    await email.sendEmail(person.email, subject, text, { html });
    await markSent(key);
    sent++;
  }

  return { sent, skipped };
}

// ---------------------------------------------------------------------------
// Job 2 — Bank-holiday closure reminders.
// ---------------------------------------------------------------------------

// If TOMORROW is a UK (England & Wales) bank holiday, email everyone that the college is
// closed. One key per date (bankholiday:<date>) covers the whole broadcast, so it goes
// out at most once regardless of how many times the scheduler ticks that day.
async function runBankHolidayReminders() {
  const date = addDays(today(), 1); // tomorrow, "YYYY-MM-DD"
  const year = Number(date.slice(0, 4));
  const match = bankHolidays.namedUkBankHolidays(year).find((h) => h.date === date);
  if (!match) return { sent: 0, skipped: 0, holiday: null };

  const key = `bankholiday:${date}`;
  if (await alreadySent(key)) return { sent: 0, skipped: 1, holiday: match.name };

  const students = await prisma.student.findMany({
    where: { active: true },
    select: { firstName: true, email: true },
  });
  const staff = await prisma.staff.findMany({
    where: { pendingActivation: false },
    select: { name: true, email: true },
  });

  // Everyone who should hear about the closure, with a name to greet by.
  const recipients = [
    ...students.map((s) => ({ email: s.email, first: s.firstName })),
    ...staff.map((s) => ({ email: s.email, first: firstNameOf(s.name) })),
  ];

  const pretty = formatDate(date);
  const subject = `College closed ${pretty} — ${match.name}`;
  let sent = 0, skipped = 0;

  for (const r of recipients) {
    if (!r.email) { skipped++; continue; }
    const greet = r.first ? r.first : "there";
    const text =
      `Hello ${greet},\n\n` +
      `Please note that EdTech will be closed on ${pretty} for the ${match.name}. ` +
      `Normal opening hours resume the next working day.\n\n` +
      `We hope you enjoy the break and take some time to rest.\n\n` +
      `Best wishes,\nEdTech`;
    const html = shell(
      "COLLEGE CLOSURE",
      "The college will be closed",
      `<p style="margin:0 0 12px">Hello ${esc(greet)},</p>
       <p style="margin:0 0 12px">Please note that EdTech will be closed on
         <strong>${esc(pretty)}</strong> for the <strong>${esc(match.name)}</strong>.
         Normal opening hours resume the next working day.</p>
       <p style="margin:0 0 12px">We hope you enjoy the break and take some time to rest.</p>
       <p style="margin:0">Best wishes,<br><strong>EdTech</strong></p>`
    );
    await email.sendEmail(r.email, subject, text, { html });
    sent++;
  }

  // Mark the broadcast done only after attempting it, so a crash mid-send retries next tick.
  await markSent(key);
  return { sent, skipped, holiday: match.name };
}

// ---------------------------------------------------------------------------
// Job 3 — Assessment deadline reminders (2 weeks out).
// ---------------------------------------------------------------------------

// Remind students enrolled on a unit about each of its assessments due exactly 14 days
// from today. Keyed per (assessment, student) so each student is nudged once per assessment.
async function runAssessmentReminders() {
  const target = addDays(today(), 14); // due in 2 weeks
  let sent = 0, skipped = 0;

  const assessments = await prisma.assessment.findMany({
    where: { dueDate: target },
    include: { unit: { select: { name: true, code: true } } },
  });

  for (const a of assessments) {
    const enrolments = await prisma.enrolment.findMany({
      where: { unitId: a.unitId },
      include: { student: true },
    });

    const unitLabel = a.unit ? `${a.unit.code} — ${a.unit.name}` : "your unit";
    const pretty = formatDate(a.dueDate);

    for (const en of enrolments) {
      const student = en.student;
      if (!student || !student.email) { skipped++; continue; }

      const key = `assessment:${a.id}:${student.id}`;
      if (await alreadySent(key)) { skipped++; continue; }

      const first = student.firstName || "there";
      const subject = `Reminder: ${a.title} is due in 2 weeks`;
      const text =
        `Hello ${first},\n\n` +
        `This is a friendly reminder that your assessment is due in two weeks.\n\n` +
        `  Assessment: ${a.title}\n` +
        `  Unit:       ${unitLabel}\n` +
        `  Type:       ${a.type}\n` +
        `  Due:        ${pretty}\n\n` +
        `Please plan your time so you can submit with confidence. If you need any support, ` +
        `reach out to your tutor early — we're here to help.\n\n` +
        `Best wishes,\nEdTech`;
      const html = shell(
        "ASSESSMENT REMINDER",
        `${esc(a.title)} — due in 2 weeks`,
        `<p style="margin:0 0 12px">Hello ${esc(first)},</p>
         <p style="margin:0 0 12px">This is a friendly reminder that your assessment is due in two weeks:</p>
         <table style="border-collapse:collapse;margin:0 0 12px">
           <tr><td style="padding:2px 12px 2px 0;color:#64748b">Assessment</td><td style="padding:2px 0"><strong>${esc(a.title)}</strong></td></tr>
           <tr><td style="padding:2px 12px 2px 0;color:#64748b">Unit</td><td style="padding:2px 0">${esc(unitLabel)}</td></tr>
           <tr><td style="padding:2px 12px 2px 0;color:#64748b">Type</td><td style="padding:2px 0">${esc(a.type)}</td></tr>
           <tr><td style="padding:2px 12px 2px 0;color:#64748b">Due</td><td style="padding:2px 0"><strong>${esc(pretty)}</strong></td></tr>
         </table>
         <p style="margin:0 0 12px">Please plan your time so you can submit with confidence. If you need any
           support, reach out to your tutor early — we're here to help.</p>
         <p style="margin:0">Best wishes,<br><strong>EdTech</strong></p>`
      );

      await email.sendEmail(student.email, subject, text, { html, from: mailFrom.ask });
      await markSent(key);
      sent++;
    }
  }

  return { sent, skipped };
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

// Run all three jobs. Each is wrapped so a failure in one never stops the others; the
// error is captured into the returned summary for the scheduler to log.
async function runDaily() {
  const summary = {};

  try { summary.birthdays = await runBirthdays(); }
  catch (e) { summary.birthdays = { error: e && e.message ? e.message : String(e) }; }

  try { summary.bankHolidays = await runBankHolidayReminders(); }
  catch (e) { summary.bankHolidays = { error: e && e.message ? e.message : String(e) }; }

  try { summary.assessments = await runAssessmentReminders(); }
  catch (e) { summary.assessments = { error: e && e.message ? e.message : String(e) }; }

  return summary;
}

module.exports = {
  runBirthdays,
  runBankHolidayReminders,
  runAssessmentReminders,
  runDaily,
  alreadySent,
  markSent,
};
