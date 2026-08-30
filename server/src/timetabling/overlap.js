// Do two timetabled things collide?
//
// Nothing anywhere in this codebase checked this before. AUTO-TIMETABLING.md §1.3
// records the position it replaces: "A tutor can be given two rooms at 18:00 on a
// Tuesday and the system will save it, publish it, and show it to students on both
// courses."
//
// Pure — strings in, booleans out, no database. Times are HH:MM and compare as
// strings, which works only because they are zero-padded; the route layer validates
// that, and overlap.test.js records why it has to.

/**
 * Do [aStart, aEnd) and [bStart, bEnd) intersect?
 *
 * HALF-OPEN, and that is the whole subtlety. An event ending at 11:00 and one
 * starting at 11:00 do NOT clash — consecutive classes are the normal shape of a
 * teaching day. A closed interval here would fire a warning on every back-to-back
 * pair in the college, and a warning that fires constantly is worse than none: it
 * buries the real double-bookings it exists to surface.
 */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Which of `existing` collide with `candidate`. Same date only.
 *
 * `candidate.id` is excluded from the result when set: editing an event re-checks it
 * against everything stored, and the stored set contains the row being edited, so
 * without this an untouched save would report the event double-booking its own room.
 */
function findClashes(candidate, existing) {
  return (existing || []).filter((e) =>
    e.id !== candidate.id &&
    e.date === candidate.date &&
    overlaps(candidate.startTime, candidate.endTime, e.startTime, e.endTime));
}

module.exports = { overlaps, findClashes };
