// Which Teams meeting a lecturer's join link belongs to, whether two overlapping
// intervals should be double-counted, and whether the minutes add up to Present, Late
// or Absent.
//
// Pure: every function here takes plain data the caller has already fetched from Graph
// or the timetable and returns a decision — no database, no HTTP, no clock. That is
// what lets the matcher's tiebreaks, the interval-merge arithmetic and the threshold's
// exact boundary all live as ordinary unit tests instead of things that only reproduce
// against a live Graph tenant on a Tuesday morning. (Same argument as
// attendanceTap.js:1-10, one level up the pipeline: attendanceTap decides whether a tap
// lands inside a session window; this module decides, once a Teams meeting has already
// been matched to a session, how much of it a student actually attended.)

/** "HH:MM" → minutes since midnight, or null when the string is not a time.
 *
 * Mirrors attendanceTap.js's toMins exactly (same regex, same bounds) but is
 * reimplemented locally rather than imported: attendanceTap.js does not export it, and
 * this module has no dependencies at all — its only contract with the rest of the
 * server is the four exported function signatures Task 7's sync engine calls.
 */
function toMins(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm ?? ""));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** minutes since midnight → "HH:MM". */
function toHHMM(mins) {
  const n = Math.max(0, Math.min(23 * 60 + 59, Math.round(mins)));
  return String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
}

// The one shape of link this module will ever look up in Graph. A join URL is not
// canonicalised — no decode-and-re-encode pass — because the exact string is the
// `$filter` lookup key against the online-meeting API: normalising `%3a` to `:` (or
// back) would produce a string Graph never indexed, turning a working link into a
// silent no-match. So the only transformation here is trimming whitespace a lecturer's
// paste picked up; everything else about the string is returned byte-for-byte.
const JOIN_URL_PATTERN = /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\/.+$/;

/**
 * Validate and normalise a pasted Teams join link.
 *
 * Returns the trimmed string unchanged when it looks like a meetup-join URL, else null.
 * Null covers every other case on purpose — not just "not a URL" but "a Teams URL of
 * the wrong shape", "empty", and non-strings — because the caller's only correct
 * response to any of them is the same: do not attempt a Graph lookup with it.
 */
function parseJoinUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return JOIN_URL_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Which candidate session a Teams meeting belongs to.
 *
 * Narrows in two passes. First, date AND startTime — a meeting's own metadata is not
 * trustworthy enough to match on subject alone, but the timetable's date+time slot is
 * exact enough to rule almost everything out. Second, only when more than one candidate
 * survives that (two classes timetabled back-to-back in the same slot, e.g. split
 * groups), the title: does the candidate's title appear in the meeting's subject, or
 * the meeting's subject in the candidate's title, case-insensitively either way,
 * because neither system is guaranteed to be the more specific string.
 *
 * The refusal branch is the point of this function, not an edge case bolted on: when
 * the date+time narrows to several candidates and the title test eliminates all of them
 * (or leaves several), this returns "ambiguous" rather than picking the first, the
 * newest, or any other tiebreak that LOOKS like a match. A wrong automatic match here
 * writes a wrong mark onto a real student's permanent attendance record, silently,
 * because nothing about an auto-sync route asks a human to confirm it — so "we could
 * not tell" has to surface as its own outcome rather than get resolved by guessing.
 * "none" is kept distinct from "ambiguous" for the same reason resolveTapSession keeps
 * "no_session_now" distinct from "term_locked" in attendanceTap.js: they are different
 * problems with different remedies (no class was on vs. we can't tell which one).
 */
function matchMeeting(meeting, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const sameSlot = list.filter((c) => c && c.date === meeting?.date && c.startTime === meeting?.startTime);
  if (sameSlot.length === 0) return { kind: "none" };
  if (sameSlot.length === 1) return { kind: "one", id: sameSlot[0].id };

  const subject = String(meeting?.subject ?? "").toLowerCase();
  const byTitle = sameSlot.filter((c) => {
    const title = String(c.title ?? "").toLowerCase();
    // An empty title never matches, deliberately: `"".includes("")` is true, so a naive
    // substring test would treat a candidate with no title as matching every subject —
    // exactly the false confidence this function exists to refuse.
    if (!title) return false;
    return subject.includes(title) || title.includes(subject);
  });
  if (byTitle.length === 1) return { kind: "one", id: byTitle[0].id };
  // Zero survivors (no title lines up with the subject) and several survivors (more
  // than one title lines up) both refuse identically — the brief is explicit that a
  // failed title test is ambiguous, never "none", because a real class WAS running in
  // that slot; the system just cannot tell which one this meeting was.
  return { kind: "ambiguous", ids: byTitle.length ? byTitle.map((c) => c.id) : sameSlot.map((c) => c.id) };
}

/**
 * Total distinct minutes a student was in the meeting, clipped to the session's own
 * window, plus the earliest time they joined at all.
 *
 * Clipping to [session.startTime, session.endTime] first matters because Teams reports
 * whatever the meeting's own start/stop were, which is not the timetabled lecture: a
 * lecturer who opens the meeting fifteen minutes early to test their camera should not
 * hand every early arrival fifteen free minutes of "attendance" before the class the
 * mark is actually for has started.
 *
 * Merging overlaps matters because a flaky connection produces more than one interval
 * for the same student — join, drop, rejoin — and Graph's attendance report does not
 * de-duplicate that for you. Summing the raw intervals would double-count the overlap
 * and could report more minutes "attended" than the session itself lasted. The sweep
 * below is the standard interval-union algorithm: clip every interval to the window,
 * drop anything that clips to nothing or fails to parse, sort by start, then walk the
 * list merging any interval whose start falls inside (or exactly at the end of) the
 * merged interval so far.
 *
 * firstJoin is deliberately the UNCLIPPED earliest join — decideStatus needs the real
 * time the student turned up (to compare against the lateness cutoff), not the time
 * clipped into the window, which would make an early arrival indistinguishable from an
 * on-time one.
 */
function attendedMinutes(intervals, session) {
  const list = Array.isArray(intervals) ? intervals : [];
  const winStart = toMins(session?.startTime);
  const winEnd = toMins(session?.endTime);

  let firstJoinMins = null;
  let firstJoin = null;
  const clipped = [];

  for (const iv of list) {
    const rawJoin = toMins(iv?.joinedAt);
    const rawLeave = toMins(iv?.leftAt);
    if (rawJoin === null || rawLeave === null) continue; // unparseable interval: ignored, not zeroed

    if (firstJoinMins === null || rawJoin < firstJoinMins) {
      firstJoinMins = rawJoin;
      firstJoin = iv.joinedAt;
    }

    if (winStart === null || winEnd === null) continue; // malformed session window: nothing to clip into
    const from = Math.max(rawJoin, winStart);
    const to = Math.min(rawLeave, winEnd);
    if (to > from) clipped.push([from, to]);
  }

  clipped.sort((a, b) => a[0] - b[0]);
  let minutes = 0;
  let curFrom = null;
  let curTo = null;
  for (const [from, to] of clipped) {
    if (curTo === null || from > curTo) {
      // A new, non-overlapping run starts: bank the previous one (if any) and open this.
      if (curTo !== null) minutes += curTo - curFrom;
      curFrom = from;
      curTo = to;
    } else if (to > curTo) {
      // Overlaps (or exactly touches) the run in progress: extend it rather than
      // opening a second run, which is the double-count this function exists to avoid.
      curTo = to;
    }
  }
  if (curTo !== null) minutes += curTo - curFrom;

  return { minutes, firstJoin };
}

/**
 * Present, Late or Absent for a student's attended minutes in one session.
 *
 * The threshold is `minutes >= ceil(sessionMinutes * minAttendancePct / 100)`, matching
 * an ordinary "you must attend at least N% to be marked present" policy stated as a
 * percentage of the whole session rather than of the time before the meeting officially
 * ends — ceil() so a college running 50% of 91 minutes requires 46 minutes, not 45.5
 * rounded away to a laxer 45.
 *
 * Lateness is judged independently of the threshold, on `firstJoin` against
 * `session.startTime + lateAfterMins` — a student who arrives late but stays long
 * enough to clear the minutes threshold is still Late, not Present, because lateness is
 * about when they turned up, not how long they stayed once they did. The comparison is
 * a zero-padded HH:MM string compare, both ends inclusive on the P side (arriving
 * exactly on the cutoff is not late), mirroring attendanceTap.js:240's
 * `now.time <= addMinutes(s.startTime, late)`.
 *
 * Below the minutes threshold is always Absent regardless of when they joined — a
 * student who arrived on time but left after five minutes did not attend the class,
 * whatever their first-join timestamp says — and it carries a remark so a mark that
 * looks identical to "never joined at all" (both "A") can be told apart on the register:
 * "Joined N of M min". A null firstJoin (never parsed a single interval) is always
 * Absent with an empty remark — there is nothing to report joining.
 */
function decideStatus({ minutes, firstJoin, session, minAttendancePct, lateAfterMins }) {
  const start = toMins(session?.startTime);
  const end = toMins(session?.endTime);
  const sessionMinutes = start === null || end === null ? 0 : Math.max(0, end - start);
  // Not `|| 0`: a college that sets either of these to 0 (no minimum at all; any
  // lateness counts) means exactly that, and attendanceTap.js's lateAfterMins comment
  // already makes the case that `||` treats a real 0 no differently from a missing
  // setting — worth keeping explicit here even though, at 0, the two happen to compute
  // the same value today.
  const pct = Number.isFinite(Number(minAttendancePct)) ? Number(minAttendancePct) : 0;
  const late = Number.isFinite(Number(lateAfterMins)) ? Number(lateAfterMins) : 0;
  const required = Math.ceil((sessionMinutes * pct) / 100);

  if (firstJoin === null || firstJoin === undefined) {
    return { status: "A", remark: "" };
  }

  if (minutes < required) {
    return { status: "A", remark: `Joined ${minutes} of ${sessionMinutes} min` };
  }

  const cutoff = toHHMM((start === null ? 0 : start) + late);
  const status = firstJoin <= cutoff ? "P" : "L";
  return { status, remark: "" };
}

module.exports = { parseJoinUrl, matchMeeting, attendedMinutes, decideStatus };
