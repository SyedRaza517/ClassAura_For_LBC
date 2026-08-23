"use strict";

/**
 * attendanceBands.js
 *
 * Pure CommonJS module (no external dependencies) for the automated
 * student-attendance email system.
 *
 * It defines:
 *   - BANDS:             the attendance percentage bands (best -> worst)
 *   - bandForPct:        resolve a percentage to its band
 *   - DEFAULT_TEMPLATES: default subject/body email templates per band
 *   - DEFAULT_VALUES:    institution/tutor placeholder values (admin editable)
 *   - fillTemplate:      substitute {token} placeholders with real values
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
/* 1) Attendance bands, ordered best -> worst. min/max are inclusive (0-100). */
/* -------------------------------------------------------------------------- */

const BANDS = [
  { key: "excellent", label: "Excellent Attendance", min: 85, max: 100 },
  { key: "great",     label: "Great Attendance",     min: 70, max: 84  },
  { key: "good",      label: "Good Attendance",       min: 60, max: 69  },
  { key: "average",   label: "Average / Monitor",     min: 50, max: 59  },
  { key: "risk",      label: "Risk Student",          min: 40, max: 49  },
  { key: "highrisk",  label: "High Risk",             min: 0,  max: 39  },
];

/* -------------------------------------------------------------------------- */
/* 2) Resolve a percentage (0..100) to its band.                              */
/*    Returns null when pct is null/undefined (or falls outside every band).  */
/* -------------------------------------------------------------------------- */

function bandForPct(pct) {
  if (pct == null) return null; // == also catches undefined
  return BANDS.find((b) => pct >= b.min && pct <= b.max) || null;
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
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  BANDS,
  bandForPct,
  DEFAULT_TEMPLATES,
  DEFAULT_VALUES,
  fillTemplate,
};
