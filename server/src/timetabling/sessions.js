// One teaching day is one or two blocks, each with its own hours.
//
// TWO SESSIONS BECOME TWO EVENTS, NOT ONE EVENT HOLDING TWO RANGES, and that decision
// is the reason this file is four dozen lines rather than a schema migration.
// TimetableEvent already IS one dated block with a start and an end, and registers.js
// already creates one register per event per group. Expressing "morning and afternoon"
// as two rows sharing a seriesId therefore costs no column, no migration and no change
// to the register generator, and it produces the two registers a college actually
// wants. The rejected alternative — a JSON `sessions` column on the event — would have
// left every reader in the module (the clash check, the room conflict finder, the
// staff timetable, the register generator, myTimetable.js) having to unpack an array
// where it currently reads two strings, and each one that forgot would silently see
// only the morning.
//
// This module validates the PAIR and nothing else. It does not know what the caller
// intends to do with them, which is what keeps it pure and testable without a database.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const MAX_SESSIONS = 2;

const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * Validate and normalise the session list on a create body.
 *
 * @param {{sessions?: Array<{start?: string, end?: string}>, start?: string, end?: string}} body
 * @returns {{sessions: Array<{start: string, end: string}>} | {error: string}}
 *
 * Returns `{ sessions }` or `{ error }` — never both, and never throws. The route layer
 * turns an error into a 400 verbatim, so every message here is written to be read by
 * the administrator who typed the times rather than by a developer.
 */
function parseSessions(body) {
  // AN ABSENT OR EMPTY ARRAY FALLS BACK TO THE TOP-LEVEL PAIR, which is what makes
  // `sessions` an addition rather than a breaking change: every client written before
  // this existed sends `start` and `end` at the top level and must keep working
  // untouched. Present-but-empty is treated the same as absent on purpose — a form
  // that renders "1 session" by emptying the array is saying the same thing as one
  // that omits it, and refusing the first would be a distinction with no meaning.
  const raw = Array.isArray(body?.sessions) && body.sessions.length
    ? body.sessions
    : [{ start: body?.start, end: body?.end }];

  // Counted BEFORE anything is validated, so "I pasted in six" gets the answer about
  // six rather than a complaint about the times in the fourth.
  if (raw.length > MAX_SESSIONS) {
    return { error: "A day may have at most two sessions." };
  }

  const out = [];
  for (const s of raw) {
    // AN ALLOWLIST: exactly two fields are read off each submitted session and
    // everything else is dropped rather than carried forward into the create. sAdmission
    // is the standing example of the other way round — it stripped a fixed list of
    // secrets, so every field added afterwards travelled by default.
    const start = str(s?.start);
    const end = str(s?.end);
    // Range-checked, not merely shaped. These times are compared as STRINGS by every
    // reader downstream — overlap.js, the ordering on the events query, the register
    // generator — and string comparison is only sound while they are zero-padded and
    // real: "9:00" sorts after "13:00", and "24:00" sorts after every genuine end time
    // and would therefore clash with nothing at all.
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
      return { error: "Session times must be HH:MM, like 09:00." };
    }
    // `<=`, so a zero-length session is refused too. 09:00-09:00 is not a class: it
    // would create a register for an hour nobody teaches, and because intervals are
    // half-open it overlaps nothing, so it would slip past every clash check in the
    // module and surface only as an unexplained empty register weeks later.
    if (end <= start) {
      return { error: "A session's end must be after the start." };
    }
    out.push({ start, end });
  }

  // Sorted before the overlap test, and the order matters twice over. It is what makes
  // the single comparison below sufficient — an unsorted pair typed afternoon-first
  // would pass a check written against out[0]/out[1] — and it is what stops the
  // afternoon block being numbered "session 1" on every screen that counts them.
  //
  // A plain string comparison rather than localeCompare, matching the house rule that
  // academic dates and times are strings compared as strings.
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  // HALF-OPEN, so back-to-back is fine and a genuine overlap is not — the same rule
  // overlap.js applies to rooms, and deliberately the same rule rather than a second
  // one: two definitions of "clash" in one module is how the room checker and the
  // session checker come to disagree about 12:00.
  //
  // Two overlapping blocks on one day are one block entered twice, and they would
  // produce two registers covering the same hour for the same students — which doubles
  // that hour in every attendance denominator the college reports on, including the
  // ones that go to a funding body. Refused rather than warned, unlike a room clash:
  // a room double-booking has legitimate readings (a split group, a nominal second
  // lecturer) and this has none, because both blocks are the same class.
  if (out.length === 2 && out[0].end > out[1].start) {
    return { error: "The two sessions overlap. Back-to-back is fine; overlapping is not." };
  }

  return { sessions: out };
}

module.exports = { parseSessions, TIME_RE, MAX_SESSIONS };
