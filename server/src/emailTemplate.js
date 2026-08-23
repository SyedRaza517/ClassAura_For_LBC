// A college's own wording for the emails the system sends.
//
// Emails are not PDFs, so "upload your template" does not apply: what a college wants
// to change is the WORDING, while the sender, logo, colours and footer keep coming
// from its branding. So each email has an editable subject and body with
// {{placeholders}}, and everything around it is assembled as before.
//
// WHY PLACEHOLDERS ARE SUBSTITUTED, NOT EVALUATED
//
// A template is text written by a customer that this server renders and sends out
// under that customer's name. It must therefore never be executable: no expressions,
// no logic, no template literals. This does one thing — replace {{key}} with a value
// from a fixed, per-email list — and anything it does not recognise is left alone
// rather than guessed at.
//
// HTML in a body is ESCAPED, not trusted. A college pasting an ampersand into a
// sentence must not break the message, and a college pasting a <script> tag must not
// have it delivered to its own applicants.
const branding = require("./branding");
const prisma = require("./db");

// Every email a college may reword, with the values it can use. This list is also
// what the editor offers, so the two cannot disagree about what exists.
const KINDS = {
  offer: {
    label: "Offer of a place",
    when: "Sent to an applicant when an offer is issued.",
    fields: ["firstName", "lastName", "fullName", "course", "intake", "intakeYear", "college", "contactEmail"],
    defaultSubject: "Your offer from {{college}}",
    defaultBody:
      "Dear {{firstName}},\n\n" +
      "We are delighted to offer you a place on {{course}} starting {{intake}} {{intakeYear}}.\n\n" +
      "Your offer letter is attached. Please read it carefully and follow the instructions to accept your place.\n\n" +
      "If you have any questions, reply to this email or contact us at {{contactEmail}}.\n\n" +
      "Kind regards\n{{college}} Admissions",
  },
  interview: {
    label: "Interview invitation",
    when: "Sent when an applicant is invited to interview.",
    fields: ["firstName", "lastName", "fullName", "course", "interviewDate", "interviewTime", "college", "contactEmail"],
    defaultSubject: "Your interview with {{college}}",
    defaultBody:
      "Dear {{firstName}},\n\n" +
      "Thank you for applying for {{course}}. We would like to invite you to an interview on " +
      "{{interviewDate}} at {{interviewTime}}.\n\n" +
      "Please reply to confirm you can attend.\n\n" +
      "Kind regards\n{{college}} Admissions",
  },
  applicationReceived: {
    label: "Application received",
    when: "Sent when someone submits the public application form.",
    fields: ["firstName", "lastName", "fullName", "course", "intake", "intakeYear", "college", "contactEmail"],
    defaultSubject: "We have received your application — {{college}}",
    defaultBody:
      "Dear {{firstName}},\n\n" +
      "Thank you for applying to {{college}} for {{course}}. We have received your application " +
      "and will be in touch once it has been reviewed.\n\n" +
      "Kind regards\n{{college}} Admissions",
  },
  pat: {
    label: "Tutorial record (PAT)",
    when: "Sent to a student after a personal tutor records a meeting.",
    fields: ["firstName", "lastName", "fullName", "tutorName", "meetingDate", "college"],
    defaultSubject: "Your tutorial record — {{college}}",
    defaultBody:
      "Dear {{firstName}},\n\n" +
      "This is a record of your meeting with {{tutorName}} on {{meetingDate}}. " +
      "Please keep it for your records.\n\n" +
      "Kind regards\n{{college}}",
  },
  attendance: {
    label: "Attendance notice",
    when: "Sent to a student whose attendance has fallen below a threshold.",
    fields: ["firstName", "lastName", "fullName", "course", "attendancePct", "college", "contactEmail"],
    defaultSubject: "Your attendance — {{college}}",
    defaultBody:
      "Dear {{firstName}},\n\n" +
      "Our records show your attendance on {{course}} is currently {{attendancePct}}%. " +
      "Regular attendance is important to your progress, and we would like to help if something " +
      "is making it difficult.\n\n" +
      "Please contact us at {{contactEmail}} so we can support you.\n\n" +
      "Kind regards\n{{college}}",
  },
};

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/** HTML-escape. Applied to every substituted VALUE and to the body itself. */
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Replace {{key}} with values[key].
 *
 * An UNKNOWN placeholder is left exactly as written rather than blanked. If a college
 * types {{studentName}} where the field is called {{fullName}}, seeing "{{studentName}}"
 * in the preview tells them what is wrong; silently sending an email with a hole in the
 * sentence does not.
 */
function substitute(text, values, { escapeValues = false } = {}) {
  return String(text || "").replace(PLACEHOLDER, (whole, key) => {
    if (!(key in values)) return whole;
    const v = values[key];
    if (v === null || v === undefined) return whole;
    return escapeValues ? esc(v) : String(v);
  });
}

/** Which placeholders in this text are not valid for this email — for the editor. */
function unknownPlaceholders(text, kind) {
  const allowed = new Set(KINDS[kind]?.fields || []);
  const bad = new Set();
  for (const m of String(text || "").matchAll(PLACEHOLDER)) if (!allowed.has(m[1])) bad.add(m[1]);
  return [...bad];
}

/**
 * The subject and body to send for one email, for the current institution.
 *
 * @returns {Promise<{subject:string, text:string, html:string, custom:boolean}>}
 */
async function render(kind, values = {}) {
  const spec = KINDS[kind];
  if (!spec) throw new Error("Unknown email template: " + kind);

  const brand = await branding.get();
  // Only values that ACTUALLY resolve are merged. Injecting "" for a field a college
  // has not set defeated this module's own rule that an unresolvable placeholder is
  // left visible: the default offer and attendance bodies both end a sentence with
  // "{{contactEmail}}.", so an unconfigured college sent "contact us at ." — a
  // sentence with a hole in it, which reads as broken software rather than as a
  // missing setting. Left as "{{contactEmail}}" it is instead obvious what to fix.
  const merged = { ...values };
  if (brand.displayName) merged.college = brand.displayName;
  if (brand.contactEmail) merged.contactEmail = brand.contactEmail;

  let row = null;
  try { row = await prisma.tenantEmailTemplate.findFirst({ where: { kind } }); } catch { row = null; }
  const custom = !!(row && row.enabled && (row.subject || row.body));

  const subject = substitute(custom && row.subject ? row.subject : spec.defaultSubject, merged);
  const text = substitute(custom && row.body ? row.body : spec.defaultBody, merged);

  // The body is escaped and only then given paragraph breaks, so a college's text is
  // rendered as text and its line breaks are honoured.
  const html = esc(text).replace(/\r?\n\r?\n/g, "</p><p>").replace(/\r?\n/g, "<br>");

  return { subject, text, html: "<p>" + html + "</p>", custom };
}

module.exports = { render, substitute, unknownPlaceholders, esc, KINDS };
