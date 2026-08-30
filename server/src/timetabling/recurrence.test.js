// Tests for weekly expansion — turning "this event, every week until December" into
// the dates it actually falls on.
//
// No database. This file is pure.
//
// Run with: node --test src/timetabling/recurrence.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { weeklyDates } = require("./recurrence");

test("steps forward in 7-day increments from the start date", () => {
  assert.deepEqual(
    weeklyDates("2026-09-01", "2026-09-22"),
    ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22"]);
});

test("the end date is inclusive when it lands on the weekday", () => {
  assert.deepEqual(weeklyDates("2026-09-01", "2026-09-08"), ["2026-09-01", "2026-09-08"]);
});

test("a range shorter than a week yields just the start date", () => {
  assert.deepEqual(weeklyDates("2026-09-01", "2026-09-03"), ["2026-09-01"]);
});

test("an end date before the start yields nothing", () => {
  assert.deepEqual(weeklyDates("2026-09-08", "2026-09-01"), []);
});

test("skipped dates are removed, not shifted", () => {
  // A cancelled week is a week with no class, not a class moved to the next week.
  // Shifting would silently push the whole term along by seven days.
  assert.deepEqual(
    weeklyDates("2026-09-01", "2026-09-22", { skip: ["2026-09-08"] }),
    ["2026-09-01", "2026-09-15", "2026-09-22"]);
});

test("it crosses a month and a year boundary correctly", () => {
  assert.deepEqual(
    weeklyDates("2026-12-22", "2027-01-12"),
    ["2026-12-22", "2026-12-29", "2027-01-05", "2027-01-12"]);
});

test("it survives the spring clock change without drifting a day", () => {
  // 29 March 2026 is when BST starts in the UK. Date arithmetic done in local time
  // lands on 23:00 the previous day and the whole series slips back one date. The
  // implementation works in UTC for exactly this reason.
  const out = weeklyDates("2026-03-23", "2026-04-06");
  assert.deepEqual(out, ["2026-03-23", "2026-03-30", "2026-04-06"]);
});

test("it is capped, so a typo in the end date cannot generate forever", () => {
  // The register generator caps at 60 weeks for the same reason. An end date of
  // 2999-01-01 is a slip of the keyboard, not a request for fifty thousand rows.
  const out = weeklyDates("2026-09-01", "2999-01-01");
  assert.equal(out.length, 60);
});

test("maxWeeks can be lowered but the default is 60", () => {
  assert.equal(weeklyDates("2026-09-01", "2999-01-01", { maxWeeks: 4 }).length, 4);
});
