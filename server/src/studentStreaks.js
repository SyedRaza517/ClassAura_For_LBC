"use strict";

/**
 * studentStreaks.js
 *
 * PURE. Turns a student's own daily attendance record into a streak count and a set
 * of badges. No Prisma here on purpose — GET /me/streaks in routes/student.js builds
 * `days` from AttendanceMark + HndSession rows and calls computeStreaks with the
 * result; this module is testable with a plain array and nothing else, the same
 * seam metrics.js/engine.js draws in the prediction feature and for the same reason
 * (the arithmetic is the part that gets argued with, and it stays testable without
 * fixtures).
 *
 * WHAT "days" MEANS. One entry per TEACHING day — a calendar date this student had
 * at least one session marked. A day with no marked session at all (a weekend, a
 * reading week, a register nobody has taken yet) is not a "false" entry — it is
 * simply ABSENT FROM THE ARRAY, because the design spec's "consecutive TEACHING
 * days" language means the streak is never dragged down by a day nothing was
 * scheduled on. That is why this module never looks at calendar gaps between the
 * dates it is given — every entry it sees already passed that test in the route, and
 * this file only ever reasons about the SEQUENCE it was handed, in order.
 *
 *   attended: true  — at least one session that day was P or L, and none was A. An
 *                     E sitting alongside a P/L does NOT change this — see
 *                     attendedForDay() below for why a mixed day counts in full
 *                     rather than being discounted a second time.
 *   attended: false — at least one session that day was marked A. Breaks the streak.
 *   attended: null  — the day had marked sessions but NONE were P/L (every one was
 *                     E) — no evidence of attendance either way. NEUTRAL: it
 *                     neither extends nor breaks a run, it BRIDGES across it — it is
 *                     skipped as if it were never in the list, so the run's LENGTH
 *                     does not grow on a null day, but a run either side of one
 *                     survives it intact.
 *
 * BADGES. `streak5` / `streak10` / `streak25` fire the FIRST time the running streak
 * reaches that length, dated the day the threshold was crossed — and stay in the
 * list even if a later gap breaks the streak, because an achievement already earned
 * is not retroactively un-earned. `perfectWeek` / `perfectMonth` fire once for the
 * first CLOSED period (ISO week / calendar month) in which every day that had
 * evidence was attended and none were an absence — "closed" meaning a later day in
 * the list falls in a different period, so the trailing, still-in-progress period
 * can never earn one: a badge a single afternoon's absence could still take back is
 * worse than one awarded a day late. `perfectUnit` is NOT computed here — the route
 * builds it from the same per-unit summarise() /me/attendance already uses, because
 * that is the one true per-unit percentage and this module has no unit boundaries to
 * reason about at all.
 */

const STREAK_THRESHOLDS = [5, 10, 25]; // -> badge keys streak5, streak10, streak25

/**
 * The single-day attendance verdict from the "P"|"L"|"E"|"A" statuses of every
 * session marked for this student on one calendar date. GET /me/streaks calls this
 * once per date to build the `days` array computeStreaks consumes; it is pulled out
 * here, pure and exported, so the rule is unit-testable on its own rather than only
 * provable by reading the route.
 *
 * any A -> false. Otherwise: every marked session E, and none P/L -> null (no
 * evidence of attendance either way). Otherwise (at least one P/L, no A — an E may
 * or may not also be present) -> true.
 *
 * A MIXED P/L + E DAY COUNTS AS ATTENDED, ruled on review after this file originally
 * shipped it as neutral. That was wrong: summarise() (attendance.js) already applies
 * E's half-credit discount exactly once, at the unit-percentage layer
 * (POINTS.E = 1 of MAX_POINTS = 2) — that is where the judgement "an Excused session
 * is worth less than a full Present" belongs. Discounting it AGAIN here, by refusing
 * to count a day the student showed up to and was marked E for only one session on,
 * reads as "this good day doesn't count": it measurably delays streak5/10/25 behind
 * days that did nothing wrong, and makes a week that is legitimately a mix of
 * attended and excused sessions permanently unable to earn perfectWeek no matter how
 * consistent the student actually was. The student attended everything they were
 * not excused from; only a day with NO P/L evidence at all (only E) stays neutral.
 */
function attendedForDay(statuses) {
  const list = Array.isArray(statuses) ? statuses : [];
  if (list.some((s) => s === "A")) return false;
  if (list.length && list.every((s) => s === "E")) return null;
  return list.length ? true : null; // no statuses at all: nothing to judge — should not occur, the route only ever calls this with at least one
}

/**
 * The ISO week a YYYY-MM-DD date falls in, as "YYYY-Www" (Monday-start). Computed by
 * hand rather than with a date library: this file is deliberately dependency-free so
 * it can be required from a script or a test with nothing else installed, matching
 * attendanceBands.js's own reasoning for staying bare.
 *
 * The "move to the Thursday of this week" trick is the standard way to compute an
 * ISO week number without a library: the ISO week a date belongs to is DEFINED as
 * the week containing that week's Thursday, which sidesteps the "does week 53 exist
 * this year" edge case by construction rather than by a special case here.
 */
function isoWeekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const mondayIndexed = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setUTCDate(d.getUTCDate() - mondayIndexed + 3); // now sitting on this week's Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstThursdayIndexed = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayIndexed + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Dates arrive as "YYYY-MM-DD" strings (house convention — dates are strings,
// compared as strings), so the calendar month is just the first 7 characters.
const monthKey = (dateStr) => dateStr.slice(0, 7);

/**
 * `perfectWeek` and `perfectMonth`, from the same list computeStreaks is walking.
 * Grouped by period key, in the order days already arrive (ascending) — so the LAST
 * key seen is the most recent period, which is the one excluded as still-open.
 */
function perfectPeriodBadges(list) {
  const badges = [];
  for (const [badgeKey, keyOf] of [["perfectWeek", isoWeekKey], ["perfectMonth", monthKey]]) {
    const groups = new Map(); // periodKey -> { hasEvidence, hasAbsence, lastDate }
    for (const day of list) {
      const key = keyOf(day.date);
      let g = groups.get(key);
      if (!g) { g = { hasEvidence: false, hasAbsence: false, lastDate: day.date }; groups.set(key, g); }
      if (day.attended === true) g.hasEvidence = true;
      if (day.attended === false) g.hasAbsence = true;
      if (day.date > g.lastDate) g.lastDate = day.date;
    }
    const keys = [...groups.keys()];
    const closedKeys = keys.slice(0, -1); // the trailing period may still be running
    for (const key of closedKeys) {
      const g = groups.get(key);
      if (g.hasEvidence && !g.hasAbsence) {
        badges.push({ key: badgeKey, earnedOn: g.lastDate });
        break; // one badge per key, awarded on the FIRST period that qualifies
      }
    }
  }
  return badges;
}

/**
 * computeStreaks({ days }) -> { current, best, badges }
 *
 * `days`: ordered `[{ date: "YYYY-MM-DD", attended: true|false|null }]` — see the
 * module header for what each value means. Missing/non-array input is treated as
 * empty rather than thrown on, matching the rest of this codebase's "malformed input
 * is handled, not crashed on" convention for a read-only endpoint.
 */
function computeStreaks({ days } = {}) {
  const list = Array.isArray(days) ? days.filter((d) => d && typeof d.date === "string") : [];

  let run = 0;   // the TRAILING streak as of the day just processed
  let best = 0;
  const badges = [];
  const earnedThresholds = new Set();

  for (const day of list) {
    if (day.attended === true) {
      run += 1;
      if (run > best) best = run;
      for (const t of STREAK_THRESHOLDS) {
        if (run >= t && !earnedThresholds.has(t)) {
          earnedThresholds.add(t);
          badges.push({ key: `streak${t}`, earnedOn: day.date });
        }
      }
    } else if (day.attended === false) {
      run = 0; // the gap — `best` is NOT reset, a personal best already happened
    }
    // attended === null: bridges. `run` is left exactly as it was — neither reset
    // nor incremented, which is what "does not count toward the run" means.
  }

  return { current: run, best, badges: [...badges, ...perfectPeriodBadges(list)] };
}

module.exports = { computeStreaks, attendedForDay, STREAK_THRESHOLDS };
