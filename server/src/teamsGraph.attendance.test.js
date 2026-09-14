// server/src/teamsGraph.attendance.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeRecords, localDateFromGraph } = require("./teamsGraph");

test("localDateFromGraph slices the calendar date from a Graph dateTime", () => {
  assert.equal(localDateFromGraph("2026-09-14T10:00:00.0000000Z"), "2026-09-14");
});

test("mergeRecords keys by person and concatenates intervals", () => {
  const recs = [
    { emailAddress: "a@x.ac.uk", identity: { user: { id: "u1" } }, attendanceIntervals: [{ joinDateTime: "2026-09-14T09:00:00Z", leaveDateTime: "2026-09-14T10:00:00Z" }] },
    { emailAddress: "a@x.ac.uk", identity: { user: { id: "u1" } }, attendanceIntervals: [{ joinDateTime: "2026-09-14T10:05:00Z", leaveDateTime: "2026-09-14T11:00:00Z" }] },
  ];
  const merged = mergeRecords(recs);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].msUserId, "u1");
  assert.equal(merged[0].intervals.length, 2);
});

test("mergeRecords drops an anonymous participant with no email and no id", () => {
  assert.equal(mergeRecords([{ attendanceIntervals: [] }]).length, 0);
});
