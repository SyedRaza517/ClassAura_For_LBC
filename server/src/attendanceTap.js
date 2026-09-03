// Which register an NFC tap belongs to, and whether it is Present or Late.
//
// Pure: it takes the candidate sessions the route has already read, plus the current
// local date and time, and returns a decision. No database, no clock — the caller reads
// the clock through clock.js and passes it in, so every boundary case in here is an
// ordinary unit test rather than something that only reproduces at 09:15 on a Tuesday.
//
// The rule, in one line: taps are accepted while the lecture is running and at no other
// time. There is no window for a lecturer to open and nothing to remember to switch off
// — the timetable already knows when the class is.

// What a self check-in writes into AttendanceMark.takenBy. It lives here, in the module
// both halves already import, because it is a value TWO routes must agree on exactly:
// the student route writes it and the lecturer's dashboard reads it back to decide
// whether a row was self-marked. Two hand-maintained copies of a string that must match
// is the ADMIN_PAGES problem, and that one is only survivable because a test checks it.
const SELF_CHECKIN_STAMP = "Self check-in (NFC)";

// The same thing, written by the rotating QR code instead of a sticker.
//
// A SECOND stamp is the whole difficulty, and it is worth being explicit about why there
// is not just one. hnd.js builds the lecturer's live view with an exact equality —
// `takenBy === SELF_CHECKIN_STAMP` — so a second string would make `selfMarked` come back
// FALSE for every QR check-in. The lecturer would then see a student who marked
// themselves rendered exactly like a student a human marked, on the one screen that
// exists to tell those two apart.
//
// The alternative — one stamp for both — was rejected. An administrator reconciling a
// disputed register needs to know whether a mark came off a sticker in the room or a code
// on a screen, because the two have different failure modes and different answers to "how
// did this get here": a sticker needs physical proximity, a screen can be photographed.
// Collapsing them would destroy that distinction to save a predicate.
//
// SELF_CHECKIN_STAMP itself is FROZEN at its current wording. Rows in both live databases
// already carry it and the live view reads it back, so changing the string would silently
// reclassify every self check-in ever recorded as staff-marked. A test pins it.
const SELF_CHECKIN_QR_STAMP = "Self check-in (QR)";

// Every stamp that means "the student did this, not a member of staff". A third capture
// method adds its stamp here and needs no other change; a test asserts every member is
// recognised by the predicate, so the list and the check cannot drift apart.
const SELF_CHECKIN_STAMPS = Object.freeze([SELF_CHECKIN_STAMP, SELF_CHECKIN_QR_STAMP]);

/**
 * Was this mark written by the student themselves?
 *
 * Exact matching, deliberately. A prefix or case-insensitive test would read a lecturer
 * who typed "self check-in" into the remark box as a machine, and the value of this column
 * is that it distinguishes a claim from an observation.
 */
function isSelfCheckIn(takenBy) {
  return typeof takenBy === "string" && SELF_CHECKIN_STAMPS.includes(takenBy);
}

/** "HH:MM" → minutes since midnight, or null when the string is not a time. */
function toMins(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm ?? ""));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** minutes since midnight → "HH:MM", clamped to the day. */
function toHHMM(mins) {
  const n = Math.max(0, Math.min(23 * 60 + 59, Math.round(mins)));
  return String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
}

// Clamped rather than wrapped, deliberately. A lecture does not cross midnight, and
// wrapping would turn "fifteen minutes before 00:05" into 23:50 — a string that sorts
// LATER than every other time of day, which would accept taps around the clock.
//
// An unparseable time is handed back untouched rather than becoming "NaN:NaN". A
// malformed startTime should refuse that one session visibly, not compare false against
// everything and look like an empty timetable.
const addMinutes = (hhmm, mins) => { const b = toMins(hhmm); return b === null ? hhmm : toHHMM(b + mins); };
const subMinutes = (hhmm, mins) => { const b = toMins(hhmm); return b === null ? hhmm : toHHMM(b - mins); };

/**
 * Is this session inside its own check-in window right now?
 *
 * THE single copy of a test that used to exist four times — the today list, the live
 * view, the QR mint route and the QR verify route each carried their own, and they had
 * already drifted: two coerced a garbage earlyGraceMins to zero and two passed it raw,
 * and the mint route's copy is the one that forgot the term entirely (see termOpenOn).
 * Four hand-synced copies of "is the class on" is how a projector ends up advertising a
 * code that every scan is refused — the mint and verify routes MUST agree to the minute.
 *
 * Both ends inclusive: a student who scanned as the class ended did arrive. Unparseable
 * times refuse that one session visibly rather than letting "NaN:NaN" compare false
 * against everything. Zero-padded HH:MM sorts chronologically, so string compares after
 * the null checks are enough.
 */
function withinSessionWindow(session, now, settings) {
  if (!session || session.date !== now?.date) return false;
  const grace = Number(settings?.earlyGraceMins) || 0;
  const from = toMins(subMinutes(session.startTime, grace));
  const to = toMins(session.endTime);
  const t = toMins(now.time);
  if (from === null || to === null || t === null) return false;
  return t >= from && t <= to;
}

/**
 * Is this term open on this date? No term at all means never term-locked — a real state
 * (the unit simply has no term) and not the same as "the term is open". Both boundary
 * days inclusive, matching PUT /sessions/:id/register: a term running "to 2026-09-01"
 * includes that day's teaching.
 */
function termOpenOn(term, date) {
  return !term || (date >= term.start && date <= term.end);
}

/**
 * Decide which of a student's sessions a tap lands on.
 *
 * @param candidates today's sessions on units this student is enrolled on. Enrolment is
 *   what makes a student eligible for a register at all, so the caller builds this list
 *   from Enrolment — the same reason the register save checks enrolment rather than mere
 *   existence, and what stops a tap attaching a student to a unit they were never on.
 * @param now { date: "YYYY-MM-DD", time: "HH:MM" } in the college's zone, from clock.js
 * @param settings { lateAfterMins, earlyGraceMins }
 * @returns { kind: "one", session, status } | { kind: "ambiguous", sessions } |
 *          { kind: "none", reason: "no_session_now" | "term_locked" }
 */
function resolveTapSession(candidates, now, settings) {
  const list = Array.isArray(candidates) ? candidates : [];
  // Not `|| 0`: a lateAfterMins of 0 is a real setting — a college that treats any
  // lateness as late — and `||` would quietly replace it with 0 anyway, but the
  // intent matters if the default ever changes.
  const late = Number.isFinite(Number(settings?.lateAfterMins)) ? Number(settings.lateAfterMins) : 0;

  // Running right now — the shared predicate, so a tap and the screens advertising
  // "open now" cannot disagree about what "now" means.
  const running = list.filter((s) => withinSessionWindow(s, now, settings));

  // Nothing running is "no class on", whatever the terms say. Reported BEFORE the term
  // check so a student who tapped at the wrong time of day is not told their term is
  // closed — two different problems with two different remedies.
  if (running.length === 0) return { kind: "none", reason: "no_session_now" };

  // The term gate, matching PUT /sessions/:id/register, which returns 423 outside the
  // window. A tap must not become a back door around a locked term.
  const open = running.filter((s) => termOpenOn(s.term, now.date));
  if (open.length === 0) return { kind: "none", reason: "term_locked" };

  // Two lectures genuinely running at once is a question only the student can answer.
  if (open.length > 1) return { kind: "ambiguous", sessions: open };

  const s = open[0];
  // Zero-padded HH:MM sorts chronologically, so a plain string compare is enough — the
  // convention already used throughout checkins.js and hnd.js. Inclusive: arriving
  // exactly on the threshold is not late, and an off-by-one here is somebody's mark.
  const status = now.time <= addMinutes(s.startTime, late) ? "P" : "L";
  return { kind: "one", session: s, status };
}

/**
 * Present or Late for one already-chosen session.
 *
 * Exported separately because the route needs it after an ambiguous result: the student
 * picked the second of two overlapping classes, and that class may have started at a
 * different time than the first. Reusing the first candidate's verdict would mark a
 * punctual student late.
 */
function statusFor(session, now, settings) {
  const late = Number.isFinite(Number(settings?.lateAfterMins)) ? Number(settings.lateAfterMins) : 0;
  return now.time <= addMinutes(session.startTime, late) ? "P" : "L";
}

module.exports = {
  addMinutes, subMinutes, resolveTapSession, statusFor, withinSessionWindow, termOpenOn,
  SELF_CHECKIN_STAMP, SELF_CHECKIN_QR_STAMP, SELF_CHECKIN_STAMPS, isSelfCheckIn,
};
