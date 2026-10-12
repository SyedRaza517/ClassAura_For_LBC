// Edge cases for the four pure functions in teamsAttendance.js.
//
// teamsAttendance.test.js covers the happy path and the headline boundaries. This file
// covers the cases that only show up against a real tenant on a bad day: a lecturer who
// pasted a link of the wrong Teams shape, two classes in a slot where one has no title
// at all, a connection that dropped and rejoined at exactly the same minute, a college
// that set its threshold to 0, and a session row whose times are malformed.
//
// Everything here is a CHARACTERISATION test: it pins what the code does today so a
// later refactor cannot change it silently. Where the behaviour is arguably wrong the
// test says so in a comment rather than asserting the behaviour somebody wishes for —
// a test that asserts a wish fails on correct code and teaches nothing.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseJoinUrl, matchMeeting, attendedMinutes, decideStatus, occurrenceForDate } = require("./teamsAttendance");

const OK_URL = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0";

/* ------------------------------------------------------------------ parseJoinUrl -- */

test("parseJoinUrl refuses a Teams URL of the WRONG shape, not just a non-Teams one", () => {
  // The module comment names this case explicitly: "a Teams URL of the wrong shape".
  // A channel link or a chat link is still teams.microsoft.com, and handing one to the
  // online-meeting $filter lookup produces a silent no-match rather than an error, so
  // it has to be refused here where the refusal is visible.
  assert.equal(parseJoinUrl("https://teams.microsoft.com/l/channel/19%3aabc/General"), null);
  assert.equal(parseJoinUrl("https://teams.microsoft.com/l/chat/0/0?users=a@x"), null);
  assert.equal(parseJoinUrl("https://teams.microsoft.com/"), null);
  // `.+` requires at least one character after the final slash.
  assert.equal(parseJoinUrl("https://teams.microsoft.com/l/meetup-join/"), null);
});

test("parseJoinUrl requires https, and is case-sensitive about the scheme and host", () => {
  assert.equal(parseJoinUrl("http://teams.microsoft.com/l/meetup-join/19%3aabc"), null);
  assert.equal(parseJoinUrl("HTTPS://TEAMS.MICROSOFT.COM/l/meetup-join/19%3aabc"), null);
});

test("parseJoinUrl returns the link byte-for-byte — percent-encoding is NEVER normalised", () => {
  // Load-bearing, and the reason the module refuses to canonicalise: the exact string is
  // the $filter key Graph indexed. Decoding %3a to ':' here would build a lookup key
  // Microsoft has never seen, and a working link would start resolving to no meeting at
  // all — a failure that looks like "the class had no attendance report" rather than
  // like a bug in us.
  const encoded = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZWQ%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d";
  assert.equal(parseJoinUrl(encoded), encoded);
  assert.ok(parseJoinUrl(encoded).includes("%3a"), "the colon must still be percent-encoded");
  assert.ok(!parseJoinUrl(encoded).includes("%3A"), "and must not have been re-cased");
});

test("parseJoinUrl trims surrounding whitespace a paste picked up, including newlines and tabs", () => {
  assert.equal(parseJoinUrl("\n\t  " + OK_URL + "  \r\n"), OK_URL);
});

test("parseJoinUrl treats every non-string as null rather than coercing it", () => {
  // Coercing would be actively harmful: String(undefined) is "undefined", which is not a
  // URL but IS a non-empty string, and a blocklist-shaped check could let it through.
  for (const bad of [undefined, 0, 1, true, false, {}, [], () => {}, Symbol("s")]) {
    assert.equal(parseJoinUrl(bad), null, `${String(bad)} must be refused`);
  }
});

/* ------------------------------------------------------------------- matchMeeting -- */

const SLOT = { date: "2026-09-14", startTime: "09:00" };

test("matchMeeting: a candidate with NO title never matches, however generic the subject", () => {
  // The single most dangerous shape in this function, and the reason the implementation
  // guards it: "".includes("") is true, so a naive substring test would make a
  // titleless candidate match EVERY subject and win the tiebreak outright. The outcome
  // must be ambiguous — a refusal — not a confident wrong mark on a real register.
  const candidates = [
    { id: "untitled", ...SLOT, title: "" },
    { id: "databases", ...SLOT, title: "Databases" },
  ];
  const r = matchMeeting({ subject: "Something else entirely", ...SLOT }, candidates);
  assert.equal(r.kind, "ambiguous");
  assert.ok(!JSON.stringify(r).includes("untitled") || r.ids.includes("databases"),
    "an empty title must not be the thing that resolved the match");
  // And with a subject that DOES name the titled class, the titled one wins outright.
  assert.deepEqual(matchMeeting({ subject: "HND Databases", ...SLOT }, candidates), { kind: "one", id: "databases" });
});

test("matchMeeting: a null or undefined title behaves exactly like an empty one", () => {
  const candidates = [
    { id: "a", ...SLOT, title: null },
    { id: "b", ...SLOT, title: undefined },
  ];
  // Both sides fail the title test, so both survive into the ambiguous list.
  const r = matchMeeting({ subject: "Lecture", ...SLOT }, candidates);
  assert.equal(r.kind, "ambiguous");
  assert.deepEqual(r.ids.sort(), ["a", "b"]);
});

test("matchMeeting: containment is tested in BOTH directions", () => {
  // Neither system is guaranteed to hold the more specific string. Microsoft's subject
  // may be the long one ("HND Databases — week 3") or the short one ("Databases") while
  // the timetable holds "Databases and Data Modelling".
  const longTitle = [
    { id: "a", ...SLOT, title: "Databases and Data Modelling" },
    { id: "b", ...SLOT, title: "Networks" },
  ];
  assert.deepEqual(matchMeeting({ subject: "Databases and Data Modelling week 3", ...SLOT }, longTitle), { kind: "one", id: "a" });
  // Subject SHORTER than the title: the title contains the subject.
  assert.deepEqual(matchMeeting({ subject: "Databases", ...SLOT }, longTitle), { kind: "one", id: "a" });
});

test("matchMeeting: the title test ignores case on both sides", () => {
  const candidates = [
    { id: "a", ...SLOT, title: "DATABASES" },
    { id: "b", ...SLOT, title: "Networks" },
  ];
  assert.deepEqual(matchMeeting({ subject: "hnd databases week 3", ...SLOT }, candidates), { kind: "one", id: "a" });
});

test("matchMeeting: when SEVERAL titles match, it refuses and names only those", () => {
  // The other ambiguous branch, and the one the existing suite does not reach. Two split
  // groups of the same unit both legitimately match the subject; picking either would be
  // a coin toss written onto one of the two groups' registers.
  const candidates = [
    { id: "grp-a", ...SLOT, title: "Databases" },
    { id: "grp-b", ...SLOT, title: "Databases" },
    { id: "nets", ...SLOT, title: "Networks" },
  ];
  const r = matchMeeting({ subject: "Databases", ...SLOT }, candidates);
  assert.equal(r.kind, "ambiguous");
  assert.deepEqual(r.ids.sort(), ["grp-a", "grp-b"]);
  assert.ok(!r.ids.includes("nets"), "a candidate the title test eliminated must not be reported as a possibility");
});

test("matchMeeting: when NO title matches, it reports every candidate in the slot", () => {
  // Distinct from the branch above: nothing survived the title test, so the honest
  // answer is "it was one of these three and we cannot tell which".
  const candidates = [
    { id: "a", ...SLOT, title: "Databases" },
    { id: "b", ...SLOT, title: "Networks" },
    { id: "c", ...SLOT, title: "Statistics" },
  ];
  const r = matchMeeting({ subject: "Zoom catch-up", ...SLOT }, candidates);
  assert.equal(r.kind, "ambiguous");
  assert.deepEqual(r.ids.sort(), ["a", "b", "c"]);
});

test("matchMeeting: the right date at the wrong time is none, and vice versa", () => {
  const c = [{ id: "a", date: "2026-09-14", startTime: "09:00", title: "Databases" }];
  assert.equal(matchMeeting({ subject: "Databases", date: "2026-09-14", startTime: "09:30" }, c).kind, "none");
  assert.equal(matchMeeting({ subject: "Databases", date: "2026-09-21", startTime: "09:00" }, c).kind, "none");
});

test("matchMeeting: start times are compared as strings, so 9:00 never equals 09:00", () => {
  // Dates and times are strings throughout this codebase (conventions.md). That makes an
  // unpadded time a non-match rather than a coincidental one, which is the safe failure:
  // it reports "none" instead of matching the wrong slot.
  const c = [{ id: "a", date: "2026-09-14", startTime: "09:00", title: "Databases" }];
  assert.equal(matchMeeting({ subject: "Databases", date: "2026-09-14", startTime: "9:00" }, c).kind, "none");
});

test("matchMeeting: a missing meeting, missing candidates or junk entries are none, never a throw", () => {
  // The sync engine calls this inside a per-meeting try block, but a throw there costs
  // the whole remaining meeting list for that run — so these have to be ordinary values.
  assert.equal(matchMeeting(undefined, undefined).kind, "none");
  assert.equal(matchMeeting(null, null).kind, "none");
  assert.equal(matchMeeting({ subject: "x", ...SLOT }, "not an array").kind, "none");
  assert.equal(matchMeeting({ subject: "x", ...SLOT }, [null, undefined]).kind, "none");
  // A null entry alongside a real one must not disturb the real match.
  assert.deepEqual(
    matchMeeting({ subject: "x", ...SLOT }, [null, { id: "a", ...SLOT, title: "Databases" }]),
    { kind: "one", id: "a" });
});

/* ----------------------------------------------------------------- attendedMinutes -- */

const WIN = { startTime: "09:00", endTime: "10:00" }; // 60 minutes

test("attendedMinutes: a reconnect is never double-counted, whether it touches or overlaps", () => {
  // Two shapes of the same real event — a connection that dropped and came back.
  //
  // The exact touch (09:00-09:30, 09:30-10:00) is arithmetic-neutral: treating it as one
  // run or two gives 60 either way, since (b-a)+(c-b) = c-a. It is pinned as documentation,
  // not as a guard, and this test does not pretend otherwise.
  //
  // The OVERLAP in the second case is the guard. Summing the clipped durations without
  // merging gives 40+40=80 minutes of a 60-minute class — the double-count the merge
  // sweep exists to prevent, and a number a lecturer would rightly query.
  const touching = attendedMinutes([
    { joinedAt: "09:00", leftAt: "09:30" },
    { joinedAt: "09:30", leftAt: "10:00" },
  ], WIN);
  assert.equal(touching.minutes, 60);

  const overlapping = attendedMinutes([
    { joinedAt: "09:00", leftAt: "09:40" },
    { joinedAt: "09:20", leftAt: "10:00" },
  ], WIN);
  assert.equal(overlapping.minutes, 60, "40 + 40 overlapping minutes is 60 of union, not 80");
});

test("attendedMinutes: an interval wholly inside another adds nothing", () => {
  // The classic double-count: Teams reports a long session and a short one nested in it
  // (two devices, phone and laptop). Summing raw would report 70 minutes of a 60-minute
  // class, which is both wrong and obviously wrong to anyone reading the register.
  const r = attendedMinutes([
    { joinedAt: "09:00", leftAt: "10:00" },
    { joinedAt: "09:10", leftAt: "09:20" },
  ], WIN);
  assert.equal(r.minutes, 60);
});

test("attendedMinutes: minutes can never exceed the session's own length", () => {
  // The invariant that makes a percentage meaningful. Three overlapping devices, each
  // spanning the whole class and beyond.
  const r = attendedMinutes([
    { joinedAt: "08:00", leftAt: "11:00" },
    { joinedAt: "08:30", leftAt: "10:30" },
    { joinedAt: "09:15", leftAt: "09:45" },
  ], WIN);
  assert.equal(r.minutes, 60);
});

test("attendedMinutes: a zero-length or inverted interval is dropped, not counted as negative", () => {
  // leftAt before joinedAt is real: clock skew between a client and the service has
  // produced it. `to > from` drops both shapes, which must not make the total negative.
  const r = attendedMinutes([
    { joinedAt: "09:10", leftAt: "09:10" },   // zero length
    { joinedAt: "09:40", leftAt: "09:20" },   // inverted
    { joinedAt: "09:00", leftAt: "09:30" },   // the only real one
  ], WIN);
  assert.equal(r.minutes, 30);
});

test("attendedMinutes: an unparseable interval is IGNORED, and never zeroes the good ones", () => {
  // conventions.md's null-is-not-zero rule, at interval level: one malformed row out of
  // Graph must not cost a student the minutes they demonstrably attended.
  const r = attendedMinutes([
    { joinedAt: "not a time", leftAt: "09:30" },
    { joinedAt: "09:00", leftAt: null },
    { joinedAt: "25:00", leftAt: "26:00" },    // out of range: toMins refuses both
    { joinedAt: "09:00", leftAt: "09:45" },    // the good one
  ], WIN);
  assert.equal(r.minutes, 45);
  assert.equal(r.firstJoin, "09:00", "firstJoin must come from a parseable interval only");
});

test("attendedMinutes: firstJoin is the earliest join even when the list arrives out of order", () => {
  const r = attendedMinutes([
    { joinedAt: "09:30", leftAt: "09:40" },
    { joinedAt: "08:55", leftAt: "09:05" },
    { joinedAt: "09:10", leftAt: "09:20" },
  ], WIN);
  assert.equal(r.firstJoin, "08:55");
});

test("attendedMinutes: firstJoin survives even when that interval clips away to nothing", () => {
  // Deliberate, and worth pinning: a student who joined the empty meeting at 08:00, left
  // before the class began and came back at 09:30 has firstJoin 08:00. Lateness is
  // judged on when they really turned up, so the early appearance counts for that
  // question even though it contributes zero minutes to the attendance total.
  const r = attendedMinutes([
    { joinedAt: "08:00", leftAt: "08:30" },   // entirely before the window: 0 minutes
    { joinedAt: "09:30", leftAt: "10:00" },   // 30 minutes
  ], WIN);
  assert.equal(r.minutes, 30);
  assert.equal(r.firstJoin, "08:00");
});

test("attendedMinutes: a malformed session window yields zero minutes but KEEPS firstJoin", () => {
  // A session row with a broken time cannot be clipped into, so no minutes can honestly
  // be claimed — but the student demonstrably joined something, and throwing that away
  // would be inventing a fact too. Characterises the `continue` after the firstJoin
  // assignment.
  const r = attendedMinutes([{ joinedAt: "09:05", leftAt: "09:55" }], { startTime: "oops", endTime: "10:00" });
  assert.equal(r.minutes, 0);
  assert.equal(r.firstJoin, "09:05");
});

test("attendedMinutes: a non-array of intervals is empty, not a throw", () => {
  for (const bad of [null, undefined, "", 0, {}]) {
    const r = attendedMinutes(bad, WIN);
    assert.equal(r.minutes, 0);
    assert.equal(r.firstJoin, null);
  }
});

/* -------------------------------------------------------------------- decideStatus -- */

test("decideStatus: the threshold is ceil(), so a half-minute is never rounded in the student's favour", () => {
  // The implementation comment's own worked example: 50% of 91 minutes is 45.5, which
  // must require 46 and not a laxer 45. This is the arithmetic a college would be asked
  // to justify at an appeal, so it gets its own test rather than riding on a round case.
  const session = { startTime: "09:00", endTime: "10:31" }; // 91 minutes
  const base = { session, minAttendancePct: 50, lateAfterMins: 15 };
  assert.equal(decideStatus({ ...base, minutes: 45, firstJoin: "09:00" }).status, "A");
  assert.equal(decideStatus({ ...base, minutes: 46, firstJoin: "09:00" }).status, "P");
});

test("decideStatus: below the threshold is ALWAYS Absent, however punctual the arrival", () => {
  // Stated outright in the implementation comment. A student who was first in and left
  // after five minutes did not attend, and must not be rescued by their arrival time.
  const session = { startTime: "09:00", endTime: "10:00" };
  const r = decideStatus({ session, minutes: 5, firstJoin: "08:59", minAttendancePct: 50, lateAfterMins: 15 });
  assert.equal(r.status, "A");
  assert.equal(r.remark, "Joined 5 of 60 min");
});

test("decideStatus: arriving late but staying the course is Late, never Present", () => {
  const session = { startTime: "09:00", endTime: "10:00" };
  const r = decideStatus({ session, minutes: 40, firstJoin: "09:20", minAttendancePct: 50, lateAfterMins: 15 });
  assert.equal(r.status, "L");
  assert.equal(r.remark, "", "a Late mark carries no remark — the lateness IS the information");
});

test("decideStatus: a threshold of 0 means exactly 0, not 'unset'", () => {
  // The code uses Number.isFinite rather than `||` precisely so a college that sets 0
  // gets 0. At 0 required, any student the report mentions at all clears the bar.
  const session = { startTime: "09:00", endTime: "10:00" };
  const r = decideStatus({ session, minutes: 0, firstJoin: "09:00", minAttendancePct: 0, lateAfterMins: 15 });
  assert.equal(r.status, "P");
});

test("decideStatus: lateAfterMins of 0 makes the start time itself the cutoff, inclusively", () => {
  const session = { startTime: "09:00", endTime: "10:00" };
  const base = { session, minutes: 60, minAttendancePct: 50, lateAfterMins: 0 };
  assert.equal(decideStatus({ ...base, firstJoin: "09:00" }).status, "P", "exactly on the hour is not late");
  assert.equal(decideStatus({ ...base, firstJoin: "09:01" }).status, "L");
  assert.equal(decideStatus({ ...base, firstJoin: "08:59" }).status, "P");
});

test("decideStatus: a non-numeric percentage degrades to 0 rather than NaN", () => {
  // NaN would make every comparison false and silently mark everybody Present. The
  // settings layer clamps before this is reached, but this function is called directly
  // by the sync engine and carries its own guard.
  const session = { startTime: "09:00", endTime: "10:00" };
  const r = decideStatus({ session, minutes: 1, firstJoin: "09:00", minAttendancePct: "banana", lateAfterMins: "nonsense" });
  assert.equal(r.status, "P", "required collapses to 0, so 1 minute clears it");
  assert.ok(!Number.isNaN(r.minutes));
});

test("decideStatus: both null and undefined firstJoin mean 'never seen', with an empty remark", () => {
  // The two marks look identical on a register ("A"); the remark is the only thing that
  // tells "never turned up" apart from "came, but not long enough". A student the report
  // never names must carry NO remark, or the register implies a join that never happened.
  const session = { startTime: "09:00", endTime: "10:00" };
  for (const fj of [null, undefined]) {
    const r = decideStatus({ session, minutes: 0, firstJoin: fj, minAttendancePct: 50, lateAfterMins: 15 });
    assert.equal(r.status, "A");
    assert.equal(r.remark, "");
  }
});

test("decideStatus: a malformed session window is NOT MEASURABLE, and scores nothing", () => {
  // This test used to assert the opposite, and called it "a wart worth seeing in writing":
  // with no parseable start the required minutes collapsed to 0, the student was therefore
  // never Absent, and because the lateness cutoff was computed from midnight any real join
  // sorted after it and the mark became "L". The wart is now fixed rather than recorded.
  //
  // The reason it had to be: the same collapse made `required` 0 for a session crossing
  // midnight too, where `minutes < required` is 0 < 0 and EVERY joiner cleared even a 100%
  // threshold on no measured attendance at all — a confident "P" in the generous
  // direction. decideStatus now answers null, conventions.md's "not measurable", and the
  // caller writes no mark.
  for (const session of [
    { startTime: null, endTime: null },
    { startTime: "23:00", endTime: "00:30" }, // crosses midnight: unrepresentable here
    { startTime: "09:00", endTime: "09:00" }, // degenerate: end not after start
  ]) {
    assert.equal(decideStatus({ session, minutes: 30, firstJoin: "09:05", minAttendancePct: 50, lateAfterMins: 10 }), null);
  }
});

test("decideStatus: the remark names the session's real length, not the clipped total", () => {
  const session = { startTime: "13:00", endTime: "16:00" }; // 180 minutes
  const r = decideStatus({ session, minutes: 20, firstJoin: "13:00", minAttendancePct: 50, lateAfterMins: 15 });
  assert.equal(r.remark, "Joined 20 of 180 min");
});

/* --------------------------------------------------------------- occurrenceForDate -- */

test("occurrenceForDate: null, undefined and empty all mean no report, never a throw", () => {
  for (const bad of [null, undefined, []]) {
    assert.equal(occurrenceForDate(bad, "2026-09-14"), null);
  }
});

test("occurrenceForDate: a null date matches nothing", () => {
  assert.equal(occurrenceForDate([{ date: "2026-09-14", intervals: [] }], null), null);
});

test("occurrenceForDate: dates are matched exactly, never by prefix or by Date coercion", () => {
  const occ = [{ date: "2026-09-14", intervals: [] }];
  assert.equal(occurrenceForDate(occ, "2026-09-14T00:00:00Z"), null);
  assert.equal(occurrenceForDate(occ, "2026-9-14"), null);
});

test("occurrenceForDate: two reports on one date returns the first, deterministically", () => {
  // Graph should not produce this, but a recurrence exception plus its master can look
  // like it. Returning the first is at least stable run to run; the alternative — an
  // arbitrary pick — would make a register's marks depend on fetch order.
  const occ = [
    { date: "2026-09-14", intervals: [{ email: "first@x" }] },
    { date: "2026-09-14", intervals: [{ email: "second@x" }] },
  ];
  assert.equal(occurrenceForDate(occ, "2026-09-14").intervals[0].email, "first@x");
});
