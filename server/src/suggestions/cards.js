// Suggestion cards — the pure half of the insights feed.
//
// WHY THIS FEATURE IS DETERMINISTIC RULES AND NOT A MODEL. The evidence gathered
// for the staff roadmap (docs/staff-roadmap/2026-09-13-research-and-options.md) is
// blunt: prediction that stops at a flag changes nothing, and what moved outcomes
// in every study that showed movement was a named, actionable next step in front
// of the right person. These cards are that next step, computed from figures the
// platform already trusts — and because each one may send a member of staff to a
// student's door, every card must be explainable in one sentence when questioned.
// A rule can be; a weight matrix cannot.
//
// Pure — no database, no clock (today arrives as a string), no request — for the
// same reason prediction/engine.js is: the arithmetic that decides whether a name
// is put in front of a lecturer gets tests that run in milliseconds.
//
// The rules this module inherits from the rest of the codebase, enforced here and
// asserted by its tests:
//   * NULL IS NOT ZERO. A student with no marks is unmeasured, not absent; a null
//     percentage never compares against a threshold.
//   * DENOMINATOR FLOORS. A percentage resting on a handful of marks is a
//     measurement of the register, not the student (or the unit), and drives
//     nothing here.
//   * A CARD THAT WOULD FIRE FOR NOBODY IS null, never an empty shell.

const DAY_MS = 24 * 60 * 60 * 1000;
const daysBetween = (fromISO, toISO) =>
  Math.floor((Date.parse(toISO + "T00:00:00Z") - Date.parse(fromISO + "T00:00:00Z")) / DAY_MS);

// The one place a list of people becomes a sentence: first names up to three, then
// "+N more" — a card is a headline, and the tap shows the list.
const nameList = (names) =>
  names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3} more` : "");

/** The published card shape — built here so no caller can add a field by accident. */
const card = (kind, severity, title, detail, count, screen = null) =>
  ({ kind, severity, title, detail, count, screen });

/**
 * Students of the caller's own units who have not been SEEN (a P or L mark) for
 * `staleDays`+. `lastAttendedOn: null` means two very different things and the
 * `hasMarks` flag is what separates them: with marks but no recent presence the
 * student is long gone (worse than any date in the window); with no marks at all
 * they were never measured, and reporting the unmeasured as missing is the exact
 * failure the null-is-not-zero rule exists to stop.
 */
function staleAttendanceCard({ students, today, staleDays = 14, urgentDays = 21 }) {
  const stale = students
    .filter((s) => s.hasMarks)
    .map((s) => ({ ...s, gone: s.lastAttendedOn === null ? Infinity : daysBetween(s.lastAttendedOn, today) }))
    .filter((s) => s.gone >= staleDays)
    .sort((a, b) => b.gone - a.gone);
  if (!stale.length) return null;
  const worst = stale[0].gone;
  return card(
    "stale-attendance",
    worst >= urgentDays ? "urgent" : "warn",
    `${stale.length} of your students ${stale.length === 1 ? "hasn't" : "haven't"} attended in ${staleDays}+ days`,
    `${nameList(stale.map((s) => s.name))} — longest ${Number.isFinite(worst) ? `${worst} days` : "a while"}. Worth a conversation before it hardens.`,
    stale.length,
    "classes",
  );
}

/**
 * Students under `threshold`% on one of the caller's units, with at least
 * `minMarked` marked sessions behind the figure. Strictly below: 60.0 is on the
 * line the college drew, not under it.
 */
function lowAttendanceCard({ rows, minMarked = 6, threshold = 60 }) {
  const low = rows.filter((r) => r.pct != null && r.marked >= minMarked && r.pct < threshold);
  if (!low.length) return null;
  low.sort((a, b) => a.pct - b.pct);
  return card(
    "low-attendance",
    "warn",
    `${low.length} student${low.length === 1 ? "" : "s"} under ${threshold}% on your units`,
    `${nameList(low.map((r) => `${r.name} (${Math.round(r.pct)}% on ${r.unitCode})`))}.`,
    low.length,
    "classes",
  );
}

/**
 * Units whose attendance fell `dropPp`+ percentage points, recent window against
 * the prior one. BOTH windows need `minMarks` marks: a thin side proves nothing,
 * and a null side (term break, unit not yet running) is not a collapse.
 */
function unitTrendCards({ units, minMarks = 30, dropPp = 10 }) {
  return units
    .filter((u) => u.recentPct != null && u.priorPct != null
      && u.recentMarks >= minMarks && u.priorMarks >= minMarks
      && (u.priorPct - u.recentPct) >= dropPp)
    .sort((a, b) => (b.priorPct - b.recentPct) - (a.priorPct - a.recentPct))
    .map((u) => card(
      "unit-trend",
      "warn",
      `${u.name}'s attendance is falling`,
      `${Math.round(u.priorPct - u.recentPct)} points down over the last three weeks (${Math.round(u.priorPct)}% → ${Math.round(u.recentPct)}%). Something changed — timetable, assessment load, the room.`,
      1,
      null,
    ));
}

/** High-risk students with no open intervention — the caseload nobody owns yet. */
function unownedRiskCard({ count }) {
  if (!count) return null;
  return card(
    "unowned-risk",
    "urgent",
    `${count} high-risk student${count === 1 ? "" : "s"} with nobody assigned`,
    `${count === 1 ? "A student" : "Students"} at or below the intervention band with no open intervention. Predictive Analysis → Interventions is where they get an owner.`,
    count,
    null,
  );
}

/** Leave requests that have sat undecided long enough to be a card, not a badge. */
function stalePendingLeaveCard({ count, oldestDays }) {
  if (!count) return null;
  return card(
    "stale-leave",
    "info",
    `${count} leave request${count === 1 ? "" : "s"} waiting over a week`,
    `The oldest has waited ${oldestDays} day${oldestDays === 1 ? "" : "s"}. An undecided request blocks somebody's plans either way.`,
    count,
    "approval",
  );
}

module.exports = { staleAttendanceCard, lowAttendanceCard, unitTrendCards, unownedRiskCard, stalePendingLeaveCard };
