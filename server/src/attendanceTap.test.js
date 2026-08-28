// Which register a tap belongs to, and whether it is Present or Late.
//
// No database. The route layer hands over the sessions it has already read, so every
// interesting case is a plain object and a call — the same reason src/prediction/ and
// src/vle/*Normalise.js are shaped this way. Boundaries that would otherwise only
// reproduce at 09:15 on a Tuesday are ordinary assertions here.
//
// Run with: node --test src/attendanceTap.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { addMinutes, subMinutes, resolveTapSession } = require("./attendanceTap");

const TODAY = "2026-09-01";

/** One candidate session. Times are HH:MM; term null means "not term-locked". */
const session = (over = {}) => ({
  id: "s1",
  unitId: "u1",
  unitCode: "LM",
  unitName: "Leadership and Management",
  date: TODAY,
  startTime: "09:00",
  endTime: "12:00",
  term: null,
  ...over,
});

const at = (time, date = TODAY) => ({ date, time });
const settings = (over = {}) => ({ lateAfterMins: 15, earlyGraceMins: 0, ...over });

/* -------------------------------------------------------------------------- */
/* Clock arithmetic                                                            */
/* -------------------------------------------------------------------------- */

test("adding and subtracting minutes rolls the hour correctly", () => {
  assert.equal(addMinutes("09:00", 15), "09:15");
  assert.equal(addMinutes("09:50", 15), "10:05");
  assert.equal(subMinutes("09:00", 15), "08:45");
  assert.equal(subMinutes("09:05", 15), "08:50");
});

test("arithmetic clamps at the ends of the day rather than wrapping", () => {
  // A lecture does not cross midnight. Wrapping would turn "15 minutes before 00:05"
  // into 23:50 — a time LATER in the string ordering than everything else, which would
  // accept taps all day long.
  assert.equal(subMinutes("00:05", 15), "00:00");
  assert.equal(addMinutes("23:55", 15), "23:59");
});

test("an unparseable time is handed back untouched rather than becoming NaN", () => {
  // A malformed startTime must not silently become "NaN:NaN" and compare false against
  // everything, which would refuse every student on that session with no explanation.
  assert.equal(addMinutes("", 15), "");
  assert.equal(subMinutes("nonsense", 15), "nonsense");
});

/* -------------------------------------------------------------------------- */
/* Choosing the session                                                        */
/* -------------------------------------------------------------------------- */

test("no sessions at all is a refusal, not a crash", () => {
  const r = resolveTapSession([], at("09:07"), settings());
  assert.equal(r.kind, "none");
  assert.equal(r.reason, "no_session_now");
});

test("one lecture running now is marked present", () => {
  const r = resolveTapSession([session()], at("09:07"), settings());
  assert.equal(r.kind, "one");
  assert.equal(r.session.id, "s1");
  assert.equal(r.status, "P");
});

test("a tap BEFORE the lecture starts is refused when grace is zero", () => {
  // This is the rule as specified: not before the lecture.
  const r = resolveTapSession([session()], at("08:58"), settings({ earlyGraceMins: 0 }));
  assert.equal(r.kind, "none");
  assert.equal(r.reason, "no_session_now");
});

test("the same tap is accepted once the college allows five minutes of grace", () => {
  const r = resolveTapSession([session()], at("08:58"), settings({ earlyGraceMins: 5 }));
  assert.equal(r.kind, "one");
  assert.equal(r.status, "P");
});

test("a tap AFTER the lecture ends is refused", () => {
  const r = resolveTapSession([session()], at("12:01"), settings());
  assert.equal(r.kind, "none");
  assert.equal(r.reason, "no_session_now");
});

test("a tap on the closing minute still counts", () => {
  // The lecture is running at 12:00. Excluding the boundary would refuse a student who
  // tapped as the class ended, which is a real arrival.
  const r = resolveTapSession([session()], at("12:00"), settings());
  assert.equal(r.kind, "one");
});

test("a tap on the opening minute counts", () => {
  const r = resolveTapSession([session()], at("09:00"), settings({ earlyGraceMins: 0 }));
  assert.equal(r.kind, "one");
  assert.equal(r.status, "P");
});

test("yesterday's session is not a candidate today", () => {
  const r = resolveTapSession([session({ date: "2026-08-31" })], at("09:07"), settings());
  assert.equal(r.kind, "none");
  assert.equal(r.reason, "no_session_now");
});

/* -------------------------------------------------------------------------- */
/* Present or Late                                                             */
/* -------------------------------------------------------------------------- */

test("exactly on the late threshold is still Present", () => {
  // 09:00 + 15 = 09:15. A student who made it inside the window was not late, and an
  // off-by-one here decides a real student's mark.
  const r = resolveTapSession([session()], at("09:15"), settings({ lateAfterMins: 15 }));
  assert.equal(r.status, "P");
});

test("one minute past the threshold is Late", () => {
  const r = resolveTapSession([session()], at("09:16"), settings({ lateAfterMins: 15 }));
  assert.equal(r.status, "L");
});

test("a tap inside the early grace is Present, never Late", () => {
  const r = resolveTapSession([session()], at("08:57"), settings({ earlyGraceMins: 5 }));
  assert.equal(r.status, "P");
});

test("a zero lateness threshold makes one minute in Late, and the start minute Present", () => {
  // A college that treats any lateness as late must still not mark the punctual late.
  assert.equal(resolveTapSession([session()], at("09:00"), settings({ lateAfterMins: 0 })).status, "P");
  assert.equal(resolveTapSession([session()], at("09:01"), settings({ lateAfterMins: 0 })).status, "L");
});

/* -------------------------------------------------------------------------- */
/* Term lock                                                                   */
/* -------------------------------------------------------------------------- */

test("a session whose term has ended is refused, and says so", () => {
  // The register save returns 423 outside the term window. A tap must not become a back
  // door around it, and the reason has to be distinguishable from "no class on" or
  // nobody can tell a locked term from an empty timetable.
  const r = resolveTapSession(
    [session({ term: { name: "Term 3", start: "2026-01-05", end: "2026-06-30" } })],
    at("09:07"), settings(),
  );
  assert.equal(r.kind, "none");
  assert.equal(r.reason, "term_locked");
});

test("a term that has not started yet is refused the same way", () => {
  const r = resolveTapSession(
    [session({ term: { name: "Term 5", start: "2026-10-01", end: "2026-12-20" } })],
    at("09:07"), settings(),
  );
  assert.equal(r.reason, "term_locked");
});

test("a session inside its term window is marked normally", () => {
  const r = resolveTapSession(
    [session({ term: { name: "Term 4", start: "2026-08-01", end: "2026-12-20" } })],
    at("09:07"), settings(),
  );
  assert.equal(r.kind, "one");
  assert.equal(r.status, "P");
});

test("the term boundary days are inclusive at both ends", () => {
  // A term running "to 2026-09-01" includes the first of September. Excluding it would
  // lock the register on the last teaching day of term.
  const r = resolveTapSession(
    [session({ term: { name: "Term 4", start: "2026-09-01", end: "2026-09-01" } })],
    at("09:07"), settings(),
  );
  assert.equal(r.kind, "one");
});

test("term_locked is only reported when a lecture was actually running", () => {
  // A locked term AND no class on is "no class on". Reporting the lock would tell a
  // student their term is closed when in fact they tapped at the wrong time of day —
  // two different problems with two different remedies.
  const r = resolveTapSession(
    [session({ endTime: "10:00", term: { name: "Term 3", start: "2026-01-05", end: "2026-06-30" } })],
    at("14:00"), settings(),
  );
  assert.equal(r.reason, "no_session_now");
});

/* -------------------------------------------------------------------------- */
/* More than one                                                               */
/* -------------------------------------------------------------------------- */

test("two lectures running at once asks the student which", () => {
  const r = resolveTapSession(
    [session(), session({ id: "s2", unitId: "u2", unitCode: "OBM", unitName: "Organisational Behaviour" })],
    at("09:07"), settings(),
  );
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.sessions.length, 2);
});

test("a term-locked overlap does not make the open one ambiguous", () => {
  // Only one of these can be marked, so there is nothing to ask about.
  const r = resolveTapSession(
    [
      session(),
      session({ id: "s2", unitId: "u2", term: { name: "Term 3", start: "2026-01-05", end: "2026-06-30" } }),
    ],
    at("09:07"), settings(),
  );
  assert.equal(r.kind, "one");
  assert.equal(r.session.id, "s1");
});

test("a session that has already ended does not make a running one ambiguous", () => {
  const r = resolveTapSession(
    [session(), session({ id: "s2", unitId: "u2", startTime: "07:00", endTime: "08:30" })],
    at("09:07"), settings(),
  );
  assert.equal(r.kind, "one");
  assert.equal(r.session.id, "s1");
});
