// Two students, one handset, one class — the pure rule.
//
// This is what the brief actually asks for. The note reads "no other student should be
// able to log in with another student's credentials and mark that other student present",
// and the tempting reading is that this is a LOGIN problem: bind an account to a device,
// refuse the second one. That was considered and rejected, and the reasoning is worth
// keeping because the rejected design is the one somebody will propose again.
//
// Refusing a second device punishes the wrong people. A student whose phone was lost,
// broken, replaced, borrowed or simply out of battery is refused at the door, in the
// middle of a lecture, by a rule they cannot argue with — and the person doing the
// proxying is inconvenienced for about thirty seconds, because clearing site data mints a
// new device id. The friction lands entirely on honest students and the deterrent lands
// on nobody.
//
// What proxy attendance actually looks like from the server is different and much harder
// to shed: ONE HANDSET, TWO STUDENT ACCOUNTS, THE SAME REGISTER. A student marking
// themselves in and then marking a friend in has to do both from the phone in their hand.
// They can clear site data between the two — and then it is two handsets and this sees
// nothing — but that is a deliberate act, taken every time, and it is a good deal more
// than the nothing that stands in the way today.
//
// SO THIS FLAGS AND NEVER REFUSES. It is evidence put in front of a member of staff who
// knows the room, not a verdict. There are entirely innocent explanations — a student
// whose phone is dead borrowing one for ten seconds is the obvious one — and a system
// that recorded an academic-misconduct finding on this alone would be wrong often enough
// to be dangerous. What it does is make the pattern VISIBLE on the register, which is
// where somebody who can judge it is already looking.
//
// PURE, and tested without a database, like presence.js and the settings module: the rule
// deciding what a college is shown about its own students should not need a Postgres to
// exercise.

/**
 * Which students on this register share a handset with which others.
 *
 * Takes the marks for ONE session — `{ studentId, deviceId }` — and returns a Map from
 * studentId to the array of other studentIds marked from the same device. Students with
 * no collision are absent from the Map rather than present with an empty array, so a
 * caller can ask `groups.has(id)` and mean it.
 */
function sharedDeviceGroups(marks) {
  const byDevice = new Map();
  // Array.isArray, not `marks || []`: a number is not iterable and for...of throws on it,
  // which would be a 500 on the register read a lecturer opens with a room in front of
  // them. Anything that is not a list of marks is no marks.
  for (const m of Array.isArray(marks) ? marks : []) {
    // A MARK WITH NO DEVICE IS NOT A GROUP. Null is the common case, not an edge one —
    // every mark a lecturer set, and every self check-in made before the column existed —
    // so treating null as a value would collect an entire register into one "shared
    // handset" and report the lecturer's own class as mass proxy attendance. This is the
    // null-is-not-zero convention: not recorded is not a value.
    if (!m || !m.deviceId || !m.studentId) continue;
    if (!byDevice.has(m.deviceId)) byDevice.set(m.deviceId, []);
    const seen = byDevice.get(m.deviceId);
    // One student marked twice from one handset is not two students. It should not be
    // reachable — @@unique([sessionId, studentId]) — but a caller passing marks from more
    // than one session would produce it, and "shares a handset with themselves" is a
    // nonsense a screen would render.
    if (!seen.includes(m.studentId)) seen.push(m.studentId);
  }

  const out = new Map();
  for (const students of byDevice.values()) {
    if (students.length < 2) continue;
    for (const id of students) out.set(id, students.filter((other) => other !== id));
  }
  return out;
}

module.exports = { sharedDeviceGroups };
