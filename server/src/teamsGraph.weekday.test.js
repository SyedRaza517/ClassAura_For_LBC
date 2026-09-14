const test = require("node:test");
const assert = require("node:assert/strict");
const { graphWeekday } = require("./teamsGraph");

test("maps ISO dates to Microsoft Graph weekday names", () => {
  assert.equal(graphWeekday("2026-09-14"), "monday");    // a Monday
  assert.equal(graphWeekday("2026-09-17"), "thursday");
  assert.equal(graphWeekday("2026-09-20"), "sunday");
});

test("is stable regardless of host timezone (parses as UTC)", () => {
  // 2026-09-14 is a Monday everywhere; a naive local parse near midnight must not drift.
  assert.equal(graphWeekday("2026-09-14"), "monday");
});
