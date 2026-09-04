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

const { addMinutes, subMinutes, resolveTapSession, statusFor } = require("./attendanceTap");

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

// statusFor is a SECOND copy of the Present-or-Late expression, and it is the one the
// QR scan actually runs through (routes/student.js). Every boundary test below it goes
// through resolveTapSession instead, so until these four existed, changing `<=` to `<`
// in statusFor marked every punctual scanner Late with a completely green suite.
//
// The two must agree, so each of these asserts the value AND that both copies say it.
const bothSay = (time, opts) => {
  const s = settings(opts);
  const viaResolve = resolveTapSession([session()], at(time), s);
  const viaStatusFor = statusFor(session(), at(time), s);
  assert.equal(viaStatusFor, viaResolve.status,
    `the two Present-or-Late copies disagree at ${time}: statusFor said ${viaStatusFor}, resolveTapSession said ${viaResolve.status}`);
  return viaStatusFor;
};

test("the scan path calls it Present exactly on the late threshold", () => {
  assert.equal(bothSay("09:15", { lateAfterMins: 15 }), "P");
});

test("the scan path calls it Late one minute past the threshold", () => {
  assert.equal(bothSay("09:16", { lateAfterMins: 15 }), "L");
});

test("the scan path treats a zero threshold the same way a tap does", () => {
  assert.equal(bothSay("09:00", { lateAfterMins: 0 }), "P");
  assert.equal(bothSay("09:01", { lateAfterMins: 0 }), "L");
});

test("a missing or unusable lateness setting falls back to zero, not to forgiving", () => {
  // The route may hand it whatever the settings row holds. A NaN here must not read as
  // "infinitely late-tolerant", which would mark a student two hours in as Present.
  assert.equal(statusFor(session(), at("09:00"), {}), "P");
  assert.equal(statusFor(session(), at("09:01"), {}), "L");
  assert.equal(statusFor(session(), at("09:01"), { lateAfterMins: "not a number" }), "L");
});

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

// ---------------------------------------------------------------------------
// Which marks were written by the student rather than by a person in the room
// ---------------------------------------------------------------------------
//
// routes/hnd.js builds the lecturer's live view with `takenBy === SELF_CHECKIN_STAMP` —
// an exact equality against one string. A second capture method writing a second stamp
// would make selfMarked come back FALSE for every check-in it takes, so the one screen
// built to show the difference between "a student marked themselves" and "a human marked
// them" would assert the opposite of the truth. Hence a predicate rather than a compare,
// and hence these tests: this is the ADMIN_PAGES failure shape — a value two places must
// agree on — and that one is only survivable because a test checks it.

const {
  SELF_CHECKIN_STAMP, SELF_CHECKIN_QR_STAMP, SELF_CHECKIN_STAMPS, isSelfCheckIn,
} = require("./attendanceTap");

test("the NFC stamp keeps its exact historical wording", () => {
  // Pinned deliberately. Rows in both live databases already carry this string, and the
  // lecturer's view reads it back. Changing it would silently reclassify every self
  // check-in ever recorded as staff-marked. If this test fails, the fix is to restore the
  // string, not to update the test.
  assert.equal(SELF_CHECKIN_STAMP, "Self check-in (NFC)");
});

test("a QR check-in counts as self-marked", () => {
  assert.equal(isSelfCheckIn(SELF_CHECKIN_QR_STAMP), true);
});

test("an NFC check-in still counts as self-marked", () => {
  assert.equal(isSelfCheckIn(SELF_CHECKIN_STAMP), true);
});

test("every registered self check-in stamp is recognised by the predicate", () => {
  // The guard against a third capture method being added to the list and forgotten in the
  // predicate — which is the same bug this predicate exists to fix, one level up.
  for (const stamp of SELF_CHECKIN_STAMPS) {
    assert.equal(isSelfCheckIn(stamp), true, `${stamp} is registered but not recognised`);
  }
});

test("a mark taken by a member of staff is not self-marked", () => {
  for (const takenBy of ["A. Khan", "Self check-in", "self check-in (qr)", "", null, undefined]) {
    assert.equal(isSelfCheckIn(takenBy), false, `${JSON.stringify(takenBy)} must not read as self-marked`);
  }
});

/* -------------------------------------------------------------------------- */
/* One "open now" predicate for every surface                                  */
/* -------------------------------------------------------------------------- */
// The window test used to exist four times across hnd.js and student.js, drifting in how
// it coerced earlyGraceMins — and the QR mint route's private copy dropped the term
// entirely, which put a live code on the projector for a session every scan of which was
// refused 423. These two helpers are the single copy, and these tests pin the semantics
// the routes must all share.

const { withinSessionWindow, termOpenOn } = require("./attendanceTap");

test("a session running now, on today's date, is within its window", () => {
  assert.equal(withinSessionWindow(session(), at("09:07"), settings()), true);
});

test("both ends of the window are inclusive — the closing minute is still attendance", () => {
  assert.equal(withinSessionWindow(session(), at("09:00"), settings()), true);
  assert.equal(withinSessionWindow(session(), at("12:00"), settings()), true);
  assert.equal(withinSessionWindow(session(), at("12:01"), settings()), false);
});

test("before the start is outside the window when grace is zero", () => {
  assert.equal(withinSessionWindow(session(), at("08:59"), settings({ earlyGraceMins: 0 })), false);
});

test("early grace opens the window before the start", () => {
  assert.equal(withinSessionWindow(session(), at("08:50"), settings({ earlyGraceMins: 10 })), true);
  assert.equal(withinSessionWindow(session(), at("08:49"), settings({ earlyGraceMins: 10 })), false);
});

test("another day is outside the window whatever the time says", () => {
  // A session dated tomorrow at this exact time must not read as running today.
  assert.equal(withinSessionWindow(session({ date: "2026-09-02" }), at("09:07")), false);
});

test("an unusable earlyGraceMins reads as zero rather than poisoning the compare", () => {
  // `{ earlyGraceMins: "ten" }` is reachable from any JSON client. NaN minutes must not
  // make subMinutes hand back a string that compares false against every time of day.
  assert.equal(withinSessionWindow(session(), at("09:07"), settings({ earlyGraceMins: "ten" })), true);
  assert.equal(withinSessionWindow(session(), at("08:59"), settings({ earlyGraceMins: "ten" })), false);
});

test("a malformed session time refuses that session rather than comparing garbage", () => {
  // Matching resolveTapSession: refuse the one broken session visibly, do not let
  // "NaN:NaN" decide anything.
  assert.equal(withinSessionWindow(session({ startTime: "nonsense" }), at("09:07"), settings()), false);
  assert.equal(withinSessionWindow(session({ endTime: "" }), at("09:07"), settings()), false);
});

test("no term at all means never term-locked — a real state, not an open term", () => {
  assert.equal(termOpenOn(null, TODAY), true);
  assert.equal(termOpenOn(undefined, TODAY), true);
});

test("a date inside the term, boundaries included, is open", () => {
  const term = { start: "2026-09-01", end: "2026-12-19" };
  assert.equal(termOpenOn(term, "2026-09-01"), true);
  assert.equal(termOpenOn(term, "2026-10-15"), true);
  assert.equal(termOpenOn(term, "2026-12-19"), true);
});

test("a date outside the term is locked on either side", () => {
  const term = { start: "2026-09-01", end: "2026-12-19" };
  assert.equal(termOpenOn(term, "2026-08-31"), false);
  assert.equal(termOpenOn(term, "2026-12-20"), false);
});

/* -------------------------------------------------------------------------- */
/* The lecturer's hand on the window                                           */
/* -------------------------------------------------------------------------- */
// A class that finishes early should stop accepting scans when the lecturer says so,
// not when the timetable does; and a lecturer with late arrivals should be able to hold
// the door open past the end. Both live on the session row and both flow through the
// ONE predicate, so every surface — the code, the badge, the scan — agrees.

test("a session the lecturer has closed accepts nothing, even mid-window", () => {
  assert.equal(withinSessionWindow(session({ checkInClosedAt: new Date("2026-09-01T09:30:00Z") }), at("09:40"), settings()), false);
});

test("a class held open past its end keeps accepting until the held-open time, inclusive", () => {
  const held = session({ checkInOpenUntil: "12:20" });
  assert.equal(withinSessionWindow(held, at("12:10"), settings()), true);
  assert.equal(withinSessionWindow(held, at("12:20"), settings()), true);
  assert.equal(withinSessionWindow(held, at("12:21"), settings()), false);
});

test("holding open never shortens the timetabled window", () => {
  // An openUntil EARLIER than the end is not a way to close early; that is what
  // checkInClosedAt is for. The later of the two wins.
  assert.equal(withinSessionWindow(session({ checkInOpenUntil: "10:00" }), at("11:30"), settings()), true);
});

test("a malformed held-open time is ignored rather than refusing the whole class", () => {
  assert.equal(withinSessionWindow(session({ checkInOpenUntil: "later" }), at("11:30"), settings()), true);
  assert.equal(withinSessionWindow(session({ checkInOpenUntil: "later" }), at("12:01"), settings()), false);
});

test("reopening clears the close: no closedAt plus a held-open time accepts again", () => {
  assert.equal(withinSessionWindow(session({ checkInClosedAt: null, checkInOpenUntil: "12:15" }), at("12:10"), settings()), true);
});
