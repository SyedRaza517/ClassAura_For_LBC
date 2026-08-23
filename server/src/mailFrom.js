// Per-category "From" addresses — the college's Microsoft 365 shared mailboxes.
//
// Different kinds of automated email go out from different mailboxes so replies land in
// the right team's inbox (all on the edtech.co.uk domain):
//   attendance  → attendance@edtech.co.uk   (attendance emails)
//   pat         → PAT@edtech.co.uk          (PAT / tutorial records)
//   ask         → ASK@edtech.co.uk          (academic queries, reminders)
//   wellbeing   → Wellbeing@edtech.co.uk    (wellbeing / support)
//
// Pass one of these as `from` to email.sendEmail(to, subject, body, { html, from }).
//
// NOTE (Microsoft 365): the authenticated SMTP mailbox (SMTP_USER, e.g. staffhub@) must
// have "Send As" permission on each shared mailbox below, or Microsoft rejects the send
// with 5.2.252 SendAsDenied — exactly like sending as admissions@. Grant Send As on each
// shared mailbox in the M365 / Exchange admin centre. Each address can also be overridden
// with an env var without a code change.
const NAME = "EdTech";

module.exports = {
  attendance: process.env.MAIL_FROM_ATTENDANCE || `${NAME} Attendance <attendance@edtech.co.uk>`,
  pat:        process.env.MAIL_FROM_PAT        || `${NAME} PAT <PAT@edtech.co.uk>`,
  ask:        process.env.MAIL_FROM_ASK        || `${NAME} ASK <ASK@edtech.co.uk>`,
  wellbeing:  process.env.MAIL_FROM_WELLBEING  || `${NAME} Wellbeing <Wellbeing@edtech.co.uk>`,
};
