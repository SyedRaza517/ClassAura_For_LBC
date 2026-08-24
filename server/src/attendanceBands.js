"use strict";

/**
 * attendanceBands.js
 *
 * Pure CommonJS module (no external dependencies, and deliberately no Prisma) for
 * the automated student-attendance email system.
 *
 * It defines:
 *   - DEFAULT_BANDS:     the attendance percentage bands EVERY college starts with
 *   - bandForPct:        resolve a percentage to its band, against any band list
 *   - normaliseBands:    validate + tidy a college's own band list before storing it
 *   - DEFAULT_TEMPLATES: default subject/body email templates per band
 *   - GENERIC_TEMPLATE:  the letter a college's OWN, newly-invented band starts with
 *   - DEFAULT_VALUES:    institution/tutor placeholder values (admin editable)
 *   - fillTemplate:      substitute {token} placeholders with real values
 *
 * Bands are PER COLLEGE. Every college monitors attendance against its own
 * thresholds, so the list below is only the starting point: the stored, per-tenant
 * list lives in attendanceBandConfig.js, which resolves to exactly this array for a
 * college that has configured nothing. That is why the six bands here are ordinary
 * DEFAULTS and not a hardcoded special case — a college that never opens the band
 * editor is served the same array through the same code path as one that has.
 *
 * Email bodies are PLAIN TEXT. Line breaks use "\n"; paragraphs are
 * separated by "\n\n"; bullet lines start with "• ".
 *
 * Placeholder tokens used inside the templates (resolved via fillTemplate):
 *   {firstName} {programme} {pct} {period} {missedRate} {vle}
 *   {tutorName} {jobTitle} {department} {institution} {officeHours}
 *   {respondByDate} {respondDays} {patContact} {wellbeingContact}
 *   {academicSkillsContact} {financeContact} {internationalContact}
 *   {suContact} {escalationContact} {directNumber} {ecProcess}
 *   {modules}  -> reserved slot where a per-module attendance breakdown
 *                 is injected at send time (appears near the end of each body,
 *                 just before the sign-off block).
 */

/* -------------------------------------------------------------------------- */
/* 1) The DEFAULT attendance bands, ordered best -> worst.                    */
/*                                                                            */
/*    A band is: a stable `key`, a `label`, an inclusive whole-number window  */
/*    [min, max] in 0-100, a `colour` (hex — it tints the email and the admin */
/*    table), and `emailTrigger`, which says whether landing in this band     */
/*    causes the automated month-end letter to be sent.                       */
/*                                                                            */
/*    `key` is what a saved email template is filed under, so it must survive */
/*    a college renaming a band. Rename "Risk Student" to "Amber" and the     */
/*    letter that college spent an afternoon writing is still attached to it. */
/*                                                                            */
/*    Every default band triggers an email, because that is what the system   */
/*    did before bands were configurable: today's behaviour has to be exactly */
/*    what a college that configures nothing still gets.                      */
/* -------------------------------------------------------------------------- */

const MAX_BANDS = 10;

const DEFAULT_BANDS = [
  { key: "excellent", label: "Excellent Attendance", min: 85, max: 100, colour: "#15803d", emailTrigger: true },
  { key: "great",     label: "Great Attendance",     min: 70, max: 84,  colour: "#0f766e", emailTrigger: true },
  { key: "good",      label: "Good Attendance",      min: 60, max: 69,  colour: "#2563eb", emailTrigger: true },
  { key: "average",   label: "Average / Monitor",    min: 50, max: 59,  colour: "#b45309", emailTrigger: true },
  { key: "risk",      label: "Risk Student",         min: 40, max: 49,  colour: "#c2410c", emailTrigger: true },
  { key: "highrisk",  label: "High Risk",            min: 0,  max: 39,  colour: "#b91c1c", emailTrigger: true },
];

/* -------------------------------------------------------------------------- */
/* 2) Resolve a percentage to its band, against a college's own band list.    */
/* -------------------------------------------------------------------------- */

/**
 * The band a percentage falls in. `list` defaults to the built-in bands so a caller
 * with no tenant context still classifies exactly as before.
 *
 * MATCHED ON THE LOWER BOUND ONLY, walking best -> worst. That is not a shortcut,
 * it is a bug fix. Attendance percentages carry ONE DECIMAL — summariseCounts()
 * returns Math.round(x * 1000) / 10 — so a student on 69.5% satisfied NEITHER
 * `>= 70 && <= 84` NOR `>= 60 && <= 69` under the old inclusive test. They came back
 * with bandKey null, which every caller reads as "no attendance data": no band on
 * the admin table, and silently skipped by the month-end send. A student who is
 * halfway between two bands is exactly the student an attendance letter is for.
 *
 * normaliseBands guarantees the list is sorted, gap-free and starts at 0, so "the
 * first band whose lower bound this figure reaches" is total: every value in 0..100
 * lands in exactly one band, decimals included. A band's `max` is therefore purely
 * what a human is shown; the boundary that decides is the next band's `min`.
 */
function bandForPct(pct, list) {
  if (pct == null) return null; // == also catches undefined
  const bands = Array.isArray(list) && list.length ? list : DEFAULT_BANDS;
  return bands.find((b) => pct >= b.min) || null;
}

/* -------------------------------------------------------------------------- */
/* 2b) Validating a college's own band list.                                  */
/* -------------------------------------------------------------------------- */

// #abc or #aabbcc, nothing else. Same rule as branding.isHex, deliberately
// re-stated here rather than imported: branding.js pulls in Prisma, and this module
// is the one piece of the attendance system that stays dependency-free so it can be
// required from a script or a test without a database.
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const isHexColour = (v) => typeof v === "string" && HEX.test(v.trim());

// A label -> a key: lowercase, alphanumerics and dashes, capped. Only used for a
// band the college has just invented; an existing band always sends its key back so
// its saved template follows it through a rename.
function slugify(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

const isWholePct = (n) => Number.isInteger(n) && n >= 0 && n <= 100;

/**
 * Validate and tidy a proposed band list. Returns { ok: true, bands } or
 * { ok: false, error }, where `error` NAMES the offending band and says what a
 * student would experience — an administrator cannot act on "invalid".
 *
 * The rules exist because a bad band list is not a cosmetic problem: bands decide
 * who receives a letter warning them their place is at risk.
 *   - a gap    -> a student in it is classified as having no attendance data and is
 *                 skipped by the send entirely. Silent, and worst at the low end.
 *   - an overlap -> which of two letters they get depends on array order, so the
 *                 same student can move band because someone dragged a row.
 *   - not reaching 0 or 100 -> the same silent skip, for the two figures most
 *                 likely to matter (a student attending nothing, or everything).
 */
function normaliseBands(input) {
  if (!Array.isArray(input)) {
    return { ok: false, error: "Attendance bands must be sent as a list." };
  }
  if (input.length === 0) {
    return { ok: false, error: "At least one attendance band is required — without one, no student can be classified or emailed." };
  }
  if (input.length > MAX_BANDS) {
    return { ok: false, error: `A maximum of ${MAX_BANDS} attendance bands is allowed; you sent ${input.length}. Each band needs its own letter, and past ten nobody can keep them distinct.` };
  }

  const cleaned = [];
  const seenKeys = new Set();

  for (let i = 0; i < input.length; i++) {
    const raw = input[i] || {};
    const position = `Band ${i + 1}`;

    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    if (!label) return { ok: false, error: `${position} has no name. Every band needs a label — it is what students see at the top of their email.` };
    if (label.length > 60) return { ok: false, error: `${position} ("${label.slice(0, 20)}…") has a name of ${label.length} characters; the limit is 60.` };

    // Numbers arrive from a form, so "85" has to mean 85. Number("") is 0, which
    // would silently turn a blank box into a valid bound — so blanks are rejected.
    const min = raw.min === "" || raw.min == null ? NaN : Number(raw.min);
    const max = raw.max === "" || raw.max == null ? NaN : Number(raw.max);
    if (!isWholePct(min)) return { ok: false, error: `"${label}" has a lower bound of ${raw.min == null || raw.min === "" ? "(blank)" : raw.min}. Bounds must be whole numbers between 0 and 100.` };
    if (!isWholePct(max)) return { ok: false, error: `"${label}" has an upper bound of ${raw.max == null || raw.max === "" ? "(blank)" : raw.max}. Bounds must be whole numbers between 0 and 100.` };
    if (min > max) return { ok: false, error: `"${label}" runs from ${min}% down to ${max}% — its lower bound is above its upper bound.` };

    const colour = typeof raw.colour === "string" ? raw.colour.trim().toLowerCase() : "";
    if (!colour) return { ok: false, error: `"${label}" has no colour. Pick one — it tints that band's email and its row in the table.` };
    if (!isHexColour(colour)) return { ok: false, error: `"${label}" has the colour "${raw.colour}". Use a hex colour such as #15803d.` };

    // A key the caller supplied is kept as-is (that is how a template survives a
    // rename); anything else is derived from the label and de-duplicated.
    let key = typeof raw.key === "string" ? slugify(raw.key) : "";
    if (!key) key = slugify(label);
    if (!key) key = `band-${i + 1}`; // a label of pure punctuation still needs a key
    if (seenKeys.has(key)) {
      let n = 2;
      while (seenKeys.has(`${key}-${n}`)) n++;
      key = `${key}-${n}`;
    }
    seenKeys.add(key);

    cleaned.push({ key, label, min, max, colour, emailTrigger: !!raw.emailTrigger });
  }

  // Sorted best -> worst here rather than trusting the caller: the ladder's order is
  // a property of the bounds, and bandForPct walks the list top-down. A list that
  // arrived in the wrong order would otherwise classify against the wrong band.
  cleaned.sort((a, b) => b.min - a.min);

  const lowest = cleaned[cleaned.length - 1];
  const highest = cleaned[0];
  if (lowest.min !== 0) {
    return { ok: false, error: `The lowest band, "${lowest.label}", starts at ${lowest.min}%. Bands must cover 0% — a student on ${Math.max(0, lowest.min - 1)}% would fall in no band at all and be skipped by the send.` };
  }
  if (highest.max !== 100) {
    return { ok: false, error: `The highest band, "${highest.label}", stops at ${highest.max}%. Bands must cover 100% — a student with full attendance would fall in no band at all.` };
  }

  for (let i = 0; i < cleaned.length - 1; i++) {
    const upper = cleaned[i];       // the better band
    const lower = cleaned[i + 1];   // the one directly below it
    if (lower.max + 1 < upper.min) {
      return { ok: false, error: `There is a gap between "${lower.label}" (${lower.min}–${lower.max}%) and "${upper.label}" (${upper.min}–${upper.max}%). A student on ${lower.max + 1}% would fall in no band and receive nothing.` };
    }
    if (lower.max >= upper.min) {
      return { ok: false, error: `"${lower.label}" (${lower.min}–${lower.max}%) overlaps "${upper.label}" (${upper.min}–${upper.max}%). A student on ${upper.min}% would match two bands, and which letter they got would depend on the order of the list.` };
    }
  }

  return { ok: true, bands: cleaned };
}

/* -------------------------------------------------------------------------- */
/* 3) Placeholder substitution.                                               */
/*    Replaces {token} with vars[token]; unknown/undefined tokens become "".  */
/* -------------------------------------------------------------------------- */

function fillTemplate(str, vars) {
  vars = vars || {}; // defensive: allow calling without a vars object
  return String(str).replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] == null ? "" : String(vars[k])
  );
}

/* -------------------------------------------------------------------------- */
/* 4) Institution / tutor placeholder values.                                 */
/*    Admins edit these later; empty strings mark fields they must fill in.    */
/* -------------------------------------------------------------------------- */

const DEFAULT_VALUES = {
  tutorName: "",
  jobTitle: "",
  department: "",
  // Empty like the other blanks above, not a college name. These defaults are copied
  // into every institution's editable config the first time it opens the attendance
  // tab, so a name here would sign one college's letters with another's. The sending
  // side fills it in from the current institution's branding when it is still blank —
  // see attendanceEmailService.buildEmailFor.
  institution: "",
  vle: "Moodle",
  officeHours: "",
  patContact: "",
  wellbeingContact: "",
  academicSkillsContact: "",
  financeContact: "",
  internationalContact: "",
  suContact: "",
  escalationContact: "the Programme Leader",
  directNumber: "",
  ecProcess: "Extenuating Circumstances",
};

/* -------------------------------------------------------------------------- */
/* 5) Default email templates, keyed by band key.                             */
/*    Each entry is { subject, body }. Bodies are plain text.                  */
/*    The shared sign-off block is:                                           */
/*        {tutorName}                                                         */
/*        {jobTitle}                                                          */
/*        {department}                                                        */
/*        {institution}                                                       */
/*    (Email F / highrisk additionally appends {directNumber}.)               */
/*    A bare {modules} line sits just before each sign-off block.             */
/* -------------------------------------------------------------------------- */

const DEFAULT_TEMPLATES = {
  // excellent -> Email B
  excellent: {
    subject: "Well done — your attendance this term has been excellent",
    body: `Dear {firstName},

I wanted to write to you personally to say well done. Your attendance on {programme} currently stands at {pct}% for {period}, which places you among the most consistently engaged students in the cohort.

This matters more than it might seem. Students who attend consistently tend to perform noticeably better in assessments, they build stronger working relationships with peers, and they find the transition into the next level of study far smoother. What you are doing now is putting you in a strong position for the rest of the academic year.

If you would like to build on this, there are a few opportunities worth considering: becoming a Student Representative, joining the peer mentoring scheme, or speaking to me about extension activities and additional reading in your area of interest.

Please do keep it up, and if there is ever anything you need from me academically, my door is open.

{modules}

With best wishes,
{tutorName}
{jobTitle}
{department}
{institution}`,
  },

  // great -> Email A
  great: {
    subject: "Great attendance — thank you for your commitment",
    body: `Dear {firstName},

Thank you for the commitment you have shown to {programme} so far. Your attendance currently stands at {pct}% for {period}, which is a strong record and reflects real consistency on your part.

You are close to the highest attendance band, and I would encourage you to aim for it. The difference between the mid-seventies and the high eighties is usually only two or three sessions across a term, but it tends to show up in coursework quality and in how confident students feel going into assessments.

If there have been particular sessions you have missed, please do catch up on the materials on {vle} and let me know if anything needs clarifying. If there is anything getting in the way of attending — timetabling, travel, work commitments, or anything personal — I would rather know about it early so we can look at it together.

Keep going, and well done again.

{modules}

Kind regards,
{tutorName}
{jobTitle}
{department}
{institution}`,
  },

  // good -> Email C
  good: {
    subject: "Your attendance — a quick check-in",
    body: `Dear {firstName},

I hope you are keeping well. I am writing with a short update on your engagement with {programme}.

Your attendance for {period} currently stands at {pct}%. That is a reasonable record and I can see you are engaging with the programme, but it does sit below the level we expect, and it means you are missing roughly {missedRate} sessions in every ten.

My concern is less about the number itself and more about what tends to follow it. Missed sessions often contain the assessment briefing, the worked examples, or the formative feedback that the coursework depends on, and that gap usually becomes visible at submission rather than at the time.

A few practical things would help:
• Review the materials for any sessions you have missed on {vle}
• Come to {officeHours} if you need to catch up on anything specific
• Let me know if there is a recurring clash — work shifts, travel, or caring responsibilities — so we can look at what is realistic

If something is making attendance difficult, please tell me. It is much easier to sort out now than after an assessment has been missed.

{modules}

Kind regards,
{tutorName}
{jobTitle}
{department}
{institution}`,
  },

  // average -> Email D
  average: {
    subject: "Let's talk about your attendance on {programme}",
    body: `Dear {firstName},

I am writing because your attendance on {programme} currently stands at {pct}% for {period}, which is below the standard expected on the programme, and I would like to understand what is happening before it affects your results.

At this level you are missing around half of your scheduled sessions. That has a direct effect on assessment: briefings, criteria walkthroughs, formative feedback, and group work are all delivered in class, and students in this position frequently find themselves submitting work that does not meet the criteria simply because they were not present when those criteria were unpacked.

I would like to meet with you to discuss this. Please reply to this email with your availability in the next {respondDays} working days, or come to {officeHours}. This is a supportive conversation, not a disciplinary one — my aim is to find out what is getting in the way and what would help.

In the meantime, please be aware of the support available to you:
• Your Personal Academic Tutor: {patContact}
• Student Support and Wellbeing: {wellbeingContact}
• Academic Skills and Study Support: {academicSkillsContact}
• Financial guidance: {financeContact}

If you are experiencing circumstances beyond your control, there may also be formal routes available to you, including {ecProcess}, and I can talk you through how those work.

Please do reply. I would much rather hear from you than escalate this.

{modules}

Kind regards,
{tutorName}
{jobTitle}
{department}
{institution}`,
  },

  // risk -> Email E
  risk: {
    subject: "Important: your attendance requires immediate attention",
    body: `Dear {firstName},

I am writing to you about a serious concern regarding your engagement with {programme}.

Your attendance for {period} is currently {pct}%. This is significantly below the standard required and has now reached the point where it must be formally addressed under {institution}'s attendance and engagement procedure.

What this means in practice:
• Your record has been flagged for monitoring, and continued non-attendance will trigger a formal Cause for Concern
• You are at real risk of failing or being unable to complete one or more assessments this term
• If you are studying on a Student visa, {institution} has a legal obligation to monitor and report engagement to UKVI, and sustained non-attendance can affect your sponsorship

I need to hear from you. Please reply to this email within {respondDays} working days to arrange a meeting, or attend {officeHours}. If you do not respond, I will need to refer this to {escalationContact}, and that process will continue whether or not you engage with it.

I want to be clear that this email is not intended as a reprimand. In my experience, attendance at this level almost always means something else is going on — health, finances, work, housing, family, or simply feeling lost on the course. Any of these can be worked with, but only if I know about them.

Support available to you:
• Personal Academic Tutor: {patContact}
• Student Support and Wellbeing: {wellbeingContact}
• {ecProcess} guidance: {wellbeingContact}
• International Student Advice: {internationalContact}

Please get in touch. There is still time to turn this around, but that window is narrowing.

{modules}

Regards,
{tutorName}
{jobTitle}
{department}
{institution}`,
  },

  // highrisk -> Email F (adds {directNumber} to the sign-off block)
  highrisk: {
    subject:
      "URGENT: attendance below required level — response needed by {respondByDate}",
    body: `Dear {firstName},

This is a formal email regarding your engagement with {programme}, and I need you to read it carefully and respond.

Your attendance for {period} is currently {pct}%. This is critically below the required level and places your continuation on the programme at immediate risk.

The position is as follows:
• Your record has been escalated under {institution}'s attendance and engagement procedure
• You are at risk of being unable to meet the learning outcomes and of failing {programme}
• Continued non-engagement may result in formal review of your registration, up to and including withdrawal from the programme
• If you are studying on a Student visa, {institution} is required to report sustained non-engagement to UKVI, and this may result in withdrawal of sponsorship and curtailment of your visa
• If you are in receipt of student finance or a bursary, non-attendance may affect your eligibility and future payments

You must respond to this email by {respondByDate} to arrange a meeting with me. If I do not hear from you by that date, your case will be referred to {escalationContact} and progressed without your input.

I would rather that did not happen. Students reach this point for reasons that are often serious and rarely straightforward — illness, bereavement, financial hardship, mental health, caring responsibilities, or work pressures that have become unmanageable. If any of that is true for you, there are formal mechanisms designed for exactly this situation, including {ecProcess}, interruption of study, and structured catch-up support. None of them can be applied retrospectively without evidence and none of them can be applied at all unless you make contact.

Immediate support:
• Personal Academic Tutor: {patContact}
• Student Support and Wellbeing: {wellbeingContact}
• International Student Advice: {internationalContact}
• Students' Union advice service: {suContact}

Please reply to this email today, even if it is only to say that you have read it and will be in touch. A single line from you is enough to pause the escalation while we talk.

{modules}

Regards,
{tutorName}
{jobTitle}
{department}
{institution}
{directNumber}`,
  },
};

/* -------------------------------------------------------------------------- */
/* 6) The starting letter for a band a COLLEGE invented.                      */
/*                                                                            */
/*    DEFAULT_TEMPLATES above is keyed by the six built-in band keys. A band a */
/*    college adds itself ("Borderline", "Amber") has no entry there, and an   */
/*    empty template is not a neutral outcome: buildEmailFor returns null for  */
/*    a band with no template, so every student in that band is counted as     */
/*    "skipped" and quietly receives nothing. The college would see a new band */
/*    filling up on the dashboard and no letters going out, with no error      */
/*    anywhere to explain it.                                                  */
/*                                                                            */
/*    So a new band starts with a real, sendable, deliberately neutral letter  */
/*    that states the facts and invites a conversation. It says nothing that   */
/*    is only true of a good record or only true of a poor one, because the    */
/*    same text is the starting point for a band at either end of the ladder.  */
/* -------------------------------------------------------------------------- */

const GENERIC_TEMPLATE = {
  subject: "Your attendance on {programme} — {period}",
  body: `Dear {firstName},

I am writing with an update on your attendance for {programme}.

Your attendance for {period} currently stands at {pct}%.

If there is anything affecting your ability to attend — timetabling, travel, work, health, or anything personal — please do let me know. It is much easier to look at now than after an assessment has been affected.

You can review the materials for any sessions you have missed on {vle}, and you are welcome to come to {officeHours} if you would like to talk anything through.

{modules}

Kind regards,
{tutorName}
{jobTitle}
{department}
{institution}`,
};

/** The starting template for a band key: the built-in letter, or the generic one. */
function templateForKey(key) {
  return DEFAULT_TEMPLATES[key] || GENERIC_TEMPLATE;
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  DEFAULT_BANDS,
  MAX_BANDS,
  bandForPct,
  normaliseBands,
  isHexColour,
  DEFAULT_TEMPLATES,
  GENERIC_TEMPLATE,
  templateForKey,
  DEFAULT_VALUES,
  fillTemplate,
};
