// Per-category "From" addresses — the mailbox a reply should land in.
//
// Different kinds of automated email go out from different mailboxes so replies reach
// the right team: attendance, PAT (tutorial records), ASK (academic queries) and
// wellbeing. Pass one of these as `from` to email.sendEmail(to, subject, body, { from }).
//
// WHERE THE ADDRESS COMES FROM, AND WHY IN THAT ORDER
//
// This file used to be a static table of `EdTech Attendance <attendance@edtech.co.uk>`
// literals. On a second college that is not a cosmetic slip: their students' attendance
// mail would claim to come from another institution's domain, and every reply to it
// would land in that institution's inbox. So the order is now:
//
//   1. the institution's own sending addresses, from its branding — the only source
//      that can be right for more than one college;
//   2. MAIL_FROM_* in the environment, which is how a single-institution deployment was
//      configured before there was a branding screen, and still works untouched;
//   3. nothing. `undefined` is a real answer, not a failure: email.js then sends as the
//      server's own MAIL_FROM. Fabricating `<attendance@somebody-elses-domain>` to have
//      something to return is the one outcome that must never happen, and branding.js
//      declines to invent a domain for exactly the same reason.
//
// NOTE (Microsoft 365): the authenticated SMTP mailbox (SMTP_USER, e.g. staffhub@) must
// have "Send As" permission on each shared mailbox, or Microsoft rejects the send with
// 5.2.252 SendAsDenied — exactly like sending as admissions@. Grant Send As on each
// shared mailbox in the M365 / Exchange admin centre.
const branding = require("./branding");

const ENV = {
  attendance: "MAIL_FROM_ATTENDANCE",
  pat: "MAIL_FROM_PAT",
  ask: "MAIL_FROM_ASK",
  wellbeing: "MAIL_FROM_WELLBEING",
};

/**
 * The From address for one category, for the institution in the current request.
 * @returns {Promise<string|undefined>} undefined when nothing is configured — see above.
 */
async function resolve(kind) {
  const envName = ENV[kind];
  if (!envName) return undefined; // unknown category: the server's own MAIL_FROM is right
  try {
    const b = await branding.get();
    const own = b.mailFrom && b.mailFrom[kind];
    if (own) return own;
  } catch {
    // No tenant context (a script), or the branding table is not migrated yet. Fall
    // through to the environment rather than failing a send that is otherwise fine.
  }
  return process.env[envName] || undefined;
}

module.exports = {
  resolve,
  // Synchronous accessors, kept for the call sites that cannot await one (attendanceRunner).
  // They deliberately see only the environment: a synchronous caller cannot resolve the
  // current institution, and the honest answer there is "no per-team address" — which
  // sends as the server's MAIL_FROM — rather than a guess at whose mailbox it is.
  get attendance() { return process.env.MAIL_FROM_ATTENDANCE || undefined; },
  get pat() { return process.env.MAIL_FROM_PAT || undefined; },
  get ask() { return process.env.MAIL_FROM_ASK || undefined; },
  get wellbeing() { return process.env.MAIL_FROM_WELLBEING || undefined; },
};
