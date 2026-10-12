// Audit of the Teams attendance decision functions, written against the four cases an
// automated register has to survive: a student who leaves and rejoins, a participant
// nobody can resolve, a session whose own window is degenerate, and two meetings
// competing for one slot.
//
// WHY A THIRD FILE RATHER THAN MORE OF teamsAttendance.edge.test.js. That file already
// covers the headline interval arithmetic (touching, nested, clipped, inverted,
// unparseable) and says so in its header. What it does not do — and what this file
// exists for — is cross the boundary between attendedMinutes() and decideStatus():
// every failure found below is invisible to either function on its own and only appears
// when the number one produces is handed to the other. `minutes: 0` out of
// attendedMinutes is a perfectly defensible answer for a window it could not use; `0 >=
// required` inside decideStatus is a perfectly defensible comparison. Together they mark
// a student Present on no evidence at all, which is the one outcome this whole feature
// is built to refuse.
//
// Everything here is a CHARACTERISATION test, the same contract teamsAttendance.edge
// .test.js declares: it pins what the code does TODAY so a refactor cannot change it
// silently. Where today's behaviour is wrong the test says DEFECT and gives the exact
// assertion to swap in once the fix lands, rather than asserting the behaviour somebody
// wishes for — a test that asserts a wish fails on correct code and teaches nothing, and
// a red suite in a shared worktree stops two other people's runs as well as this one.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { matchMeeting, attendedMinutes, decideStatus } = require("./teamsAttendance");

// 60 minutes, the ordinary case every test below varies from.
const WIN = { startTime: "09:00", endTime: "10:00" };

/* ============================================================ 1. LEAVE AND REJOIN == */

test("attendedMinutes: three IDENTICAL intervals are one span, not three", () => {
  // Graph re-reports the same interval when a report is re-read mid-write, and the
  // attendanceRecords collection makes no promise of distinct rows — teamsSync.js:271-285
  // already concatenates two participant entries for one person precisely because of
  // that, so exact duplicates reach this function by design rather than by accident.
  //
  // This is the cheapest possible double-count: summing raw durations gives 90 minutes
  // of a 60-minute class from a student who attended half of it.
  const r = attendedMinutes([
    { joinedAt: "09:00", leftAt: "09:30" },
    { joinedAt: "09:00", leftAt: "09:30" },
    { joinedAt: "09:00", leftAt: "09:30" },
  ], WIN);
  assert.equal(r.minutes, 30, "identical duplicates must collapse, not triple");
  assert.equal(r.firstJoin, "09:00");
});

test("attendedMinutes: the GAP between two joins is not attended time", () => {
  // The discriminating case for the whole merge sweep, and the one shape neither
  // existing test covers: adjacent-but-not-overlapping. A naive implementation —
  // earliest join to latest leave, which is how a human reading the report would
  // summarise it — gives 30 here and is indistinguishable from the correct answer on
  // every overlapping fixture in the suite. Only a genuine gap tells them apart.
  //
  // It matters at the threshold: at 50% of 60 minutes a student needs 30, so the naive
  // reading clears them and the correct one does not.
  const r = attendedMinutes([
    { joinedAt: "09:00", leftAt: "09:10" },
    { joinedAt: "09:20", leftAt: "09:30" },
  ], WIN);
  assert.equal(r.minutes, 20, "the ten minutes they were away are not attendance");
  assert.notEqual(r.minutes, 30, "earliest-join-to-latest-leave would say 30");
});

test("attendedMinutes: the answer does not depend on the order Graph listed the joins", () => {
  // Graph's attendanceIntervals come back newest-first in practice, and teamsSync
  // concatenates two participant entries' lists (teamsSync.js:285) without sorting, so
  // the list this function receives can be in any order at all. The sweep sorts by start
  // before merging, which is what makes it order-independent — and asserting that over
  // every permutation is stronger than asserting one reversed case, because it also rules
  // out an implementation that happens to be right for reverse order alone.
  const ivs = [
    { joinedAt: "09:40", leftAt: "09:55" }, // 15
    { joinedAt: "09:00", leftAt: "09:20" }, // 20, overlapping the next
    { joinedAt: "09:10", leftAt: "09:30" }, // extends the first run to 09:30
  ];
  const permute = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => permute([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
  const orders = permute(ivs);
  assert.equal(orders.length, 6, "all six orderings, so a stable-sort accident cannot hide");
  for (const order of orders) {
    const r = attendedMinutes(order, WIN);
    // 09:00-09:30 (30) + 09:40-09:55 (15) = 45. Never 55 (raw sum), never 55 either way.
    assert.equal(r.minutes, 45, `order ${JSON.stringify(order.map((i) => i.joinedAt))} gave ${r.minutes}`);
    assert.equal(r.firstJoin, "09:00", "firstJoin is the earliest join, not the first listed");
  }
});

test("attendedMinutes: a short interval sharing a start with a long one is absorbed either way round", () => {
  // The sort key is the START only, so two intervals beginning at the same minute arrive
  // in whichever order the sort left them — and the merge has to be right for both. The
  // existing nested-interval test puts the long one first, which exercises the `to >
  // curTo` false branch; this puts the short one first, which exercises the extend
  // branch. Two devices joining together and one dropping early is the real shape.
  const shortFirst = attendedMinutes([
    { joinedAt: "09:00", leftAt: "09:10" },
    { joinedAt: "09:00", leftAt: "09:50" },
  ], WIN);
  const longFirst = attendedMinutes([
    { joinedAt: "09:00", leftAt: "09:50" },
    { joinedAt: "09:00", leftAt: "09:10" },
  ], WIN);
  assert.equal(shortFirst.minutes, 50);
  assert.equal(longFirst.minutes, 50);
});

test("attendedMinutes: an interval spanning both edges is clipped to the class, but firstJoin is not", () => {
  // The lecturer opened the meeting early and left it running; a keen student sat in it
  // from 08:30 to 10:30. The minutes must be the class's own 60 — the module header's
  // "fifteen free minutes" argument — while firstJoin stays the REAL arrival time,
  // because decideStatus judges lateness on it and a clipped 09:00 would make an early
  // arrival indistinguishable from an exactly-on-time one.
  const r = attendedMinutes([{ joinedAt: "08:30", leftAt: "10:30" }], WIN);
  assert.equal(r.minutes, 60, "never more than the session's own length");
  assert.equal(r.firstJoin, "08:30", "firstJoin is deliberately UNCLIPPED");
  // And it scores Present rather than Late, which is the point of keeping it unclipped.
  assert.deepEqual(
    decideStatus({ ...r, session: WIN, minAttendancePct: 90, lateAfterMins: 10 }),
    { status: "P", remark: "" },
  );
});

/* ================================================= 2. UNRESOLVABLE PARTICIPANTS == */

test("decideStatus: 'we saw nobody' and 'we saw them briefly' are different marks on the register", () => {
  // The guest/dial-in case as it reaches this function. A participant Graph could not
  // resolve to a student never produces intervals for anybody (teamsGraph.mergeRecords
  // drops a keyless record; teamsSync.js:254-260 reports an unmatched one), so the
  // rostered student ends up scored from `{ minutes: 0, firstJoin: null }`.
  //
  // Both outcomes below are "A", and that is correct — a report that WAS fetched is
  // evidence of absence. What must not collapse is the remark: the register is the
  // document a college defends at a funding audit, and "they were never in the meeting"
  // has to stay distinguishable from "they were in it for four minutes".
  const neverSeen = decideStatus({ minutes: 0, firstJoin: null, session: WIN, minAttendancePct: 50, lateAfterMins: 10 });
  assert.deepEqual(neverSeen, { status: "A", remark: "" });

  const sawThemBriefly = decideStatus({ minutes: 4, firstJoin: "09:02", session: WIN, minAttendancePct: 50, lateAfterMins: 10 });
  assert.deepEqual(sawThemBriefly, { status: "A", remark: "Joined 4 of 60 min" });
  assert.notEqual(neverSeen.remark, sawThemBriefly.remark, "the two absences must not read identically");
});

test("a student with no LEAVE time keeps their join, so the absence is VISIBLE", () => {
  // Graph documents attendanceInterval.leaveDateTime as absent for an attendee whose
  // session did not terminate cleanly — the laptop lid closed, the client crashed, or
  // the report was generated while they were still in the call. teamsGraph.zonedTime
  // (teamsGraph.js:~247) turns that null into "", and attendedMinutes' guard at
  // teamsAttendance.js:140 drops the whole interval BEFORE the firstJoin bookkeeping on
  // lines 142-145 ever sees it.
  //
  // So both halves of the evidence are lost, not one: no minutes AND no firstJoin. The
  // student then takes the `firstJoin === null` branch at teamsAttendance.js:211 and is
  // written as "A" with an EMPTY remark — byte-for-byte the mark given to someone who
  // never opened the link at all. A student who attended the whole hour and never
  // pressed Leave is the most likely person to hit this, which is the wrong way round
  // in the most expensive sense: it is an unexplained Absent on the register a college
  // defends at a funding audit, with nothing anywhere recording that a measurement was
  // attempted and failed.
  //
  // Contrast the interval whose JOIN is the unparseable half: identical outcome,
  // arrived at for a defensible reason (with no join time there is genuinely nothing to
  // report). The asymmetry is the bug — one of these two is a measurement and the
  // other is not, and they are treated alike.
  // FIXED: the join is now recorded before the interval is dropped. The student is still
  // Absent — nothing measured them attending — but the register says a measurement was
  // attempted, which is the whole difference.
  const openInterval = attendedMinutes([{ joinedAt: "09:05", leftAt: "" }], WIN);
  assert.equal(openInterval.minutes, 0);
  assert.equal(openInterval.firstJoin, "09:05",
    "the join time parsed fine and is no longer discarded with the unmeasurable span");
  assert.deepEqual(
    decideStatus({ ...openInterval, session: WIN, minAttendancePct: 50, lateAfterMins: 10 }),
    { status: "A", remark: "Joined 0 of 60 min" },
    "distinguishable from never having joined, which is the point",
  );

  // The control that proves this test discriminates: give the SAME interval a parseable
  // leave time and the student is correctly Present, which is what they actually were.
  const closedInterval = attendedMinutes([{ joinedAt: "09:05", leftAt: "10:00" }], WIN);
  assert.equal(closedInterval.minutes, 55);
  assert.equal(closedInterval.firstJoin, "09:05");
  assert.deepEqual(
    decideStatus({ ...closedInterval, session: WIN, minAttendancePct: 50, lateAfterMins: 10 }),
    { status: "P", remark: "" },
  );

  // And the shape the fix must produce: keeping the firstJoin alone is already enough to
  // make the failure VISIBLE rather than silent — "Joined 0 of 60 min" is a remark a
  // lecturer queries, where an empty one is a remark nobody reads. Pinned as the target,
  // not as today's behaviour.
  assert.notEqual(
    decideStatus({ minutes: 0, firstJoin: "09:05", session: WIN, minAttendancePct: 50, lateAfterMins: 10 }).remark,
    "",
    "the fix's outcome: an absence that says a measurement was attempted",
  );
});

/* ============================================ 3. MEETING DURATION EDGE CASES == */

test("a session crossing midnight is NOT MEASURABLE, and scores nothing at all", () => {
  // THE HEADLINE FINDING OF THIS AUDIT, and the one case where the two functions are
  // each defensible alone and wrong together.
  //
  // toMins() is minutes-since-midnight inside ONE calendar day, so a 23:00-00:30 class
  // has winStart 1380 and winEnd 30. Every interval therefore clips to nothing (`to >
  // from` is never true) and attendedMinutes returns 0 — which, read on its own, is the
  // same conservative answer it gives for any window it cannot use.
  //
  // decideStatus then computes sessionMinutes as max(0, 30 - 1380) = 0, so `required` is
  // ceil(0 * pct / 100) = 0 whatever the college set its threshold to, and `minutes <
  // required` is 0 < 0 — false. The student falls through to the lateness test and is
  // marked P, with an EMPTY remark, so nothing on the register hints that no measurement
  // happened. A student who genuinely attended eighty minutes and one who looked in for
  // thirty seconds get the identical mark.
  //
  // REACHABLE, not theoretical. The HTTP routes all refuse end <= start (hnd.js:1448,
  // timetabling.js:1644, timetabling/sessions.js:71) — but moodleAttendance.js:90-94's
  // `plus()` wraps the hour with `% 24` and moodleAttendance.js:210 creates the
  // HndSession with no such check, so a Moodle attendance session at 22:30 lasting two
  // hours imports as 22:30-00:30. Paste a Teams link onto that register (or let
  // discovery match it) and this is what the sync writes.
  const crossesMidnight = { startTime: "23:00", endTime: "00:30" };
  const attended = attendedMinutes([{ joinedAt: "23:05", leftAt: "00:25" }], crossesMidnight);
  assert.equal(attended.minutes, 0, "eighty real minutes measured as zero");
  assert.equal(attended.firstJoin, "23:05");

  const verdict = decideStatus({
    ...attended, session: crossesMidnight, minAttendancePct: 75, lateAfterMins: 10,
  });
  // FIXED, by the second of the two options this test originally offered: a degenerate
  // window is refused outright rather than scored from arithmetic that cannot represent
  // it. null is conventions.md's "not measurable", and teamsSync writes NO mark for it —
  // where the old answer was a confident "P" on zero measured minutes with no remark to
  // show it. Representing a cross-midnight window properly would mean giving this module
  // real dates instead of minutes-since-midnight, which is a much larger change and buys
  // nothing here: the rows only exist because a Moodle import wrapped the hour.
  assert.equal(verdict, null,
    "a window this module cannot represent scores nothing, rather than everything");
});

test("a zero-length session scores nothing, rather than Present on no evidence", () => {
  // startTime === endTime is the degenerate window the HTTP validators also refuse
  // (end <= start), but it arrives the same way the midnight case does — and it is the
  // simplest statement of the shared root cause: sessionMinutes 0 makes `required` 0,
  // and 0 >= 0 clears a threshold of 100%.
  //
  // Note which way the error points. A college that set 100% gets Present for a student
  // with no measured attendance at all — the generous direction, which is the one nobody
  // queries and nobody notices, unlike a wrong Absent that a student complains about.
  const zeroLength = { startTime: "09:00", endTime: "09:00" };
  const verdict = decideStatus({
    minutes: 0, firstJoin: "09:00", session: zeroLength, minAttendancePct: 100, lateAfterMins: 0,
  });
  // FIXED: end is not after start, so there is nothing to score. The old answer cleared a
  // 100% threshold with zero minutes of a zero-minute class.
  assert.equal(verdict, null,
    "a 100% threshold is no longer cleared by zero minutes of a zero-minute class");

  // The control that proves the test discriminates: give the same session one real
  // minute of length and the same zero minutes is correctly Absent.
  const oneMinute = { startTime: "09:00", endTime: "09:01" };
  assert.deepEqual(
    decideStatus({ minutes: 0, firstJoin: "09:00", session: oneMinute, minAttendancePct: 100, lateAfterMins: 0 }),
    { status: "A", remark: "Joined 0 of 1 min" },
  );
});

test("a post-midnight rejoin is not mistaken for the earliest join", () => {
  // The third symptom of the same single-day arithmetic. toHHMM() clamps to 23:59 by
  // design — it is a formatter, and a formatter has to return something — so a 23:30
  // class with a 45-minute lateness allowance gets a cutoff of 23:59 instead of 00:15.
  //
  // On its own that would be harmlessly strict. It is not, because firstJoin is chosen
  // by toMins() minimum, so an interval after midnight has a SMALLER minute count than
  // one before it: a student who joined at 23:35 and rejoined at 00:05 reports firstJoin
  // "00:05", and the string compare "00:05" <= "23:59" clears them as on time. The
  // lateness test is therefore not merely approximate across midnight, it is inverted —
  // the later a student joins after midnight, the more punctual they look.
  const lateEvening = { startTime: "23:30", endTime: "23:59" };
  const rejoinedAfterMidnight = attendedMinutes([
    { joinedAt: "23:35", leftAt: "23:59" }, // the real attendance: 24 minutes
    { joinedAt: "00:05", leftAt: "00:20" }, // after the class ended; clips to nothing
  ], lateEvening);
  assert.equal(rejoinedAfterMidnight.minutes, 24, "the in-window interval is still measured");
  // FIXED: a join more than EARLY_JOIN_ALLOWANCE_MINS before the class starts cannot be
  // this class's arrival, so 00:05 — which is a smaller minute count than 23:35 and used
  // to win the minimum — is no longer eligible to be the first join.
  assert.equal(rejoinedAfterMidnight.firstJoin, "23:35",
    "the real arrival wins, not the numerically smallest one");

  // 24 minutes clears 50% of a 29-minute session (required 15), so lateness decides the
  // mark — and it says Present for a student whose first in-window appearance was five
  // minutes after the 23:30 start, which with lateAfterMins 2 should be Late.
  assert.deepEqual(
    decideStatus({ ...rejoinedAfterMidnight, session: lateEvening, minAttendancePct: 50, lateAfterMins: 2 }),
    { status: "L", remark: "" },
    "Late, as they were — the old answer was Present because '00:05' sorted before the cutoff",
  );
  // The control: the same attendance without the post-midnight row is correctly Late.
  const noRejoin = attendedMinutes([{ joinedAt: "23:35", leftAt: "23:59" }], lateEvening);
  assert.deepEqual(
    decideStatus({ ...noRejoin, session: lateEvening, minAttendancePct: 50, lateAfterMins: 2 }),
    { status: "L", remark: "" },
  );
});

/* ================================================= 4. CONCURRENT / OVERLAPPING == */

test("matchMeeting consults startTime only — a meeting twice the class's length still matches", () => {
  // Characterisation, and deliberate rather than a gap: the matcher's slot test is
  // date + startTime equality, and endTime is never read on either side. A lecturer who
  // schedules one 09:00-11:00 Teams meeting and teaches two timetabled hours out of it
  // matches the 09:00 register, and the 10:00 register stays unmatched — which is the
  // conservative half (no wrong mark, just a missing one).
  //
  // What makes it safe is attendedMinutes clipping to the SESSION window rather than the
  // meeting's: the long meeting cannot hand the 09:00 class two hours of attendance.
  // Asserted here together so a future "match on overlap instead of equality" change has
  // to confront the clipping that makes equality survivable.
  const candidates = [
    { id: "nine", date: "2026-10-01", startTime: "09:00", endTime: "10:00", title: "Maths" },
    { id: "ten", date: "2026-10-01", startTime: "10:00", endTime: "11:00", title: "Maths" },
  ];
  const long = { subject: "Maths", date: "2026-10-01", startTime: "09:00" };
  assert.deepEqual(matchMeeting(long, candidates), { kind: "one", id: "nine" });
  // The 10:00 register is simply never offered this meeting.
  assert.deepEqual(
    matchMeeting({ ...long, startTime: "10:30" }, candidates),
    { kind: "none" },
  );
  // And the 09:00 register cannot be credited beyond its own hour.
  assert.equal(attendedMinutes([{ joinedAt: "09:00", leftAt: "11:00" }], candidates[0]).minutes, 60);
});

test("matchMeeting cannot see that another meeting already claimed the same candidate", () => {
  // Two concurrent meetings, one register. matchMeeting is called once per calendar
  // meeting (teamsSync.js:159) with the full candidate list, and has no memory between
  // calls — so BOTH meetings resolve to the same session and both would write their join
  // URL onto it. Nothing in this function refuses that; what refuses it is the
  // `teamsJoinUrl: null` filter on the updateMany at teamsSync.js:173-176, which makes it
  // first-wins.
  //
  // The consequence is real but bounded: which of the two meetings a register ends up
  // reading is decided by Graph's calendarView ordering, not by anything a human chose.
  // It is pinned here because it is the mirror image of the ambiguity the function DOES
  // refuse — two candidates for one meeting is "ambiguous", two meetings for one
  // candidate is silently "one" — and a reader of matchMeeting alone would assume both
  // directions were covered.
  const candidates = [{ id: "s1", date: "2026-10-01", startTime: "09:00", title: "Maths" }];
  assert.deepEqual(matchMeeting({ subject: "Maths group A", date: "2026-10-01", startTime: "09:00" }, candidates), { kind: "one", id: "s1" });
  assert.deepEqual(matchMeeting({ subject: "Maths group B", date: "2026-10-01", startTime: "09:00" }, candidates), { kind: "one", id: "s1" });
});

test("matchMeeting: a second candidate in the slot turns the same meeting ambiguous, and names both", () => {
  // The direction that IS refused, asserted beside the one that is not so the asymmetry
  // above cannot be mistaken for an oversight in the test rather than in the code. With
  // two split groups timetabled at 09:00 and a subject that matches neither title, the
  // verdict names every candidate in the slot — not the first, not the newest.
  const candidates = [
    { id: "groupA", date: "2026-10-01", startTime: "09:00", title: "Maths Group A" },
    { id: "groupB", date: "2026-10-01", startTime: "09:00", title: "Maths Group B" },
  ];
  const verdict = matchMeeting({ subject: "Weekly catch-up", date: "2026-10-01", startTime: "09:00" }, candidates);
  assert.equal(verdict.kind, "ambiguous");
  assert.deepEqual([...verdict.ids].sort(), ["groupA", "groupB"]);
});
