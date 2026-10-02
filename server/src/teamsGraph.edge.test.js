// Edge cases for the three pure helpers in teamsGraph.js — the layer where Microsoft's
// own data shapes land before anything in this codebase has normalised them.
//
// These matter more than their size suggests. mergeRecords decides WHO a participant is,
// and getting that wrong writes a mark onto the wrong student. localDateFromGraph decides
// WHICH WEEK a report belongs to, which is the whole safety property of recurring
// meetings. graphWeekday decides which days a recurring series is created on, and a
// timezone slip there books the class on the wrong day for the entire term.
const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeRecords, localDateFromGraph, graphWeekday } = require("./teamsGraph");

/* -------------------------------------------------------------------- mergeRecords -- */

const iv = (join, leave) => ({ joinDateTime: join, leaveDateTime: leave });

test("mergeRecords keys on the Microsoft user id, so a changed display email still merges", () => {
  // The id is the stable identity; the email on a record can arrive as the UPN on one
  // row and the mail attribute on another for the same human. Keying on the id first is
  // what keeps those one person rather than two half-attendances, either of which might
  // fall under the threshold on its own.
  const merged = mergeRecords([
    { emailAddress: "A.Khan@college.ac.uk", identity: { user: { id: "u1" } }, attendanceIntervals: [iv("2026-09-14T09:00:00Z", "2026-09-14T09:30:00Z")] },
    { emailAddress: "akhan@college.ac.uk", identity: { user: { id: "u1" } }, attendanceIntervals: [iv("2026-09-14T09:30:00Z", "2026-09-14T10:00:00Z")] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].intervals.length, 2);
});

test("mergeRecords lowercases the email, because the roster lookup matches on lowercase", () => {
  // teamsSync builds its byEmail map with s.email.toLowerCase(). If this layer handed
  // back a mixed-case address the lookup would miss and a genuine student would be
  // reported as an unmatched participant — present in the meeting, absent on the register.
  const merged = mergeRecords([
    { emailAddress: "A.Khan@College.AC.UK", attendanceIntervals: [iv("2026-09-14T09:00:00Z", "2026-09-14T09:30:00Z")] },
  ]);
  assert.equal(merged[0].email, "a.khan@college.ac.uk");
});

test("mergeRecords falls back to identity.user.email when emailAddress is absent", () => {
  const merged = mergeRecords([
    { identity: { user: { email: "B.Okoro@college.ac.uk" } }, attendanceIntervals: [iv("2026-09-14T09:00:00Z", "2026-09-14T09:10:00Z")] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].email, "b.okoro@college.ac.uk");
  assert.equal(merged[0].msUserId, null);
});

test("mergeRecords keeps an id-only participant — a guest with no email is still evidence", () => {
  const merged = mergeRecords([
    { identity: { user: { id: "u9" } }, attendanceIntervals: [iv("2026-09-14T09:00:00Z", "2026-09-14T09:10:00Z")] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].msUserId, "u9");
  assert.equal(merged[0].email, "");
});

test("mergeRecords drops a participant with neither id nor email, however many intervals", () => {
  // An anonymous dial-in. It cannot be evidence about any student, and inventing a key
  // for it would put a nameless row into the unmatched-participant count every single run.
  const merged = mergeRecords([
    { attendanceIntervals: [iv("2026-09-14T09:00:00Z", "2026-09-14T10:00:00Z")] },
    { emailAddress: "", identity: { user: {} }, attendanceIntervals: [iv("2026-09-14T09:00:00Z", "2026-09-14T10:00:00Z")] },
  ]);
  assert.equal(merged.length, 0);
});

test("mergeRecords: the SAME person with an id on one row and only an email on another is two entries", () => {
  // Characterisation of a real limitation, written down rather than wished away. The key
  // is `msUserId || email`, so these do not merge. The consequence is benign — both rows
  // resolve to the same student in teamsSync (by id, then by email) and the register
  // takes one mark per student by construction — but anyone reading the unmatched counts
  // should know the shape exists.
  const merged = mergeRecords([
    { emailAddress: "c@college.ac.uk", identity: { user: { id: "u3" } }, attendanceIntervals: [iv("2026-09-14T09:00:00Z", "2026-09-14T09:30:00Z")] },
    { emailAddress: "c@college.ac.uk", attendanceIntervals: [iv("2026-09-14T09:30:00Z", "2026-09-14T10:00:00Z")] },
  ]);
  assert.equal(merged.length, 2, "documented limitation: id-keyed and email-keyed rows do not merge");
});

test("mergeRecords tolerates a record with no attendanceIntervals at all", () => {
  // Graph emits these for someone invited who never joined. The person is kept (they are
  // identifiable) with an empty interval list, which attendedMinutes turns into zero
  // minutes and a null firstJoin — an honest "named but never seen".
  const merged = mergeRecords([{ emailAddress: "d@college.ac.uk", identity: { user: { id: "u4" } } }]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].intervals, []);
});

test("mergeRecords accepts a null or undefined record list without throwing", () => {
  assert.deepEqual(mergeRecords(null), []);
  assert.deepEqual(mergeRecords(undefined), []);
  assert.deepEqual(mergeRecords([]), []);
});

test("mergeRecords renders intervals as the app timezone's HH:MM, not UTC", () => {
  // The whole pipeline downstream compares HH:MM strings against the timetable, which is
  // written in college local time. A 09:00Z instant in September is 10:00 in London, and
  // a student who joined a 10:00 class on time would otherwise look an hour early.
  const merged = mergeRecords([
    { emailAddress: "e@college.ac.uk", attendanceIntervals: [iv("2026-09-14T09:00:00Z", "2026-09-14T10:30:00Z")] },
  ]);
  assert.match(merged[0].intervals[0].joinedAt, /^\d{2}:\d{2}$/, "must be zero-padded HH:MM");
  assert.match(merged[0].intervals[0].leftAt, /^\d{2}:\d{2}$/);
});

/* --------------------------------------------------------------- localDateFromGraph -- */

test("localDateFromGraph returns a plain YYYY-MM-DD, the format every date in this codebase uses", () => {
  assert.match(localDateFromGraph("2026-09-14T10:00:00.0000000Z"), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(localDateFromGraph("2026-09-14T10:00:00.0000000Z"), "2026-09-14");
});

test("localDateFromGraph resolves a late-evening UTC instant into the college's own day", () => {
  // The sharp one for recurring meetings. During British Summer Time, 23:30Z on the 14th
  // is 00:30 on the 15th in London. The occurrence must be filed under the day the
  // college ran the class, because occurrenceForDate matches the register's date exactly
  // and a one-day slip means a whole week's report silently matches nothing.
  assert.equal(localDateFromGraph("2026-09-14T23:30:00Z"), "2026-09-15");
  // And the reverse end: 00:30Z in winter is still the same calendar day in London.
  assert.equal(localDateFromGraph("2026-12-14T00:30:00Z"), "2026-12-14");
});

test("localDateFromGraph handles the exact BST/GMT changeover weekend", () => {
  // Clocks go back at 02:00 BST on 25 Oct 2026. A class the evening before and one the
  // morning after must land on their own dates.
  assert.equal(localDateFromGraph("2026-10-24T22:00:00Z"), "2026-10-24", "23:00 BST, still Saturday");
  assert.equal(localDateFromGraph("2026-10-25T09:00:00Z"), "2026-10-25");
});

/* ---------------------------------------------------------------------- graphWeekday -- */

test("graphWeekday names all seven days the way Microsoft Graph spells them", () => {
  // Graph's recurrence pattern rejects anything but these exact lowercase names, and a
  // rejected pattern means the series meeting is never created for the whole term.
  const week = ["2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"];
  assert.deepEqual(week.map(graphWeekday),
    ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);
});

test("graphWeekday is parsed as UTC, so a behind-UTC host cannot shift the day", () => {
  // The date strings here are calendar dates, not instants. Parsing "2026-09-14" as local
  // midnight on a host in, say, New York yields 2026-09-13T04:00Z — the previous day —
  // and a Monday class would be booked for Sunday every week of term. Appending
  // T00:00:00Z is what prevents that, and this asserts the property rather than the trick.
  const saved = process.env.TZ;
  try {
    for (const tz of ["America/Los_Angeles", "Pacific/Kiritimati", "UTC"]) {
      process.env.TZ = tz;
      assert.equal(graphWeekday("2026-09-14"), "monday", `wrong weekday under TZ=${tz}`);
      assert.equal(graphWeekday("2026-01-01"), "thursday", `wrong weekday under TZ=${tz}`);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

test("graphWeekday is right across a leap day and a year boundary", () => {
  assert.equal(graphWeekday("2028-02-29"), "tuesday");
  assert.equal(graphWeekday("2026-12-31"), "thursday");
  assert.equal(graphWeekday("2027-01-01"), "friday");
});
