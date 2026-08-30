// Which Moodle label is a deadline, and which is not.
//
// Longer than the module it tests, on purpose — every rule in it is a judgement about a
// real assessment's deadline, and every one of them fails SILENTLY if it is wrong. No
// exception, no log line, just a date that looks reasonable and is a day out, or a
// tracker full of red rows describing nothing.
const test = require("node:test");
const assert = require("node:assert/strict");
const { dueDatesByCmid, dueDateOf, dateFromEpoch } = require("./moodleActivityDates");

// 2026-11-15 23:59 Europe/London (GMT in November) = 2026-11-15T23:59:00Z
const DUE_TS = Math.floor(Date.UTC(2026, 10, 15, 23, 59, 0) / 1000);

test("a Due label is the deadline", () => {
  assert.equal(dueDateOf({ id: 1, dates: [{ label: "Due:", timestamp: DUE_TS }] }), "2026-11-15");
});

test("Moodle's other wording for the same thing is matched too", () => {
  assert.equal(dueDateOf({ id: 1, dates: [{ label: "Due date:", timestamp: DUE_TS }] }), "2026-11-15");
});

test("AN OPENING DATE IS NEVER A DEADLINE", () => {
  // The failure this rule exists to prevent: reading "Opened:" as a due date marks
  // every assessment overdue from the day it is set, filling the tracker with red that
  // describes nothing.
  assert.equal(dueDateOf({ id: 1, dates: [{ label: "Opened:", timestamp: DUE_TS }] }), null);
  assert.equal(dueDateOf({ id: 1, dates: [{ label: "Opens:", timestamp: DUE_TS }] }), null);
});

test("a quiz's closing date counts, but only when there is no due date", () => {
  const closes = { label: "Closes:", timestamp: DUE_TS };
  assert.equal(dueDateOf({ id: 1, dates: [closes] }), "2026-11-15");
  // A real due date must win, whichever order they arrive in.
  const earlier = Math.floor(Date.UTC(2026, 10, 10, 12, 0, 0) / 1000);
  assert.equal(dueDateOf({ id: 1, dates: [closes, { label: "Due:", timestamp: earlier }] }), "2026-11-10");
  assert.equal(dueDateOf({ id: 1, dates: [{ label: "Due:", timestamp: earlier }, closes] }), "2026-11-10");
});

test("an activity with no dates has no deadline, rather than a wrong one", () => {
  assert.equal(dueDateOf({ id: 1 }), null);
  assert.equal(dueDateOf({ id: 1, dates: [] }), null);
  assert.equal(dueDateOf(null), null);
});

test("timestamp 0 is Moodle's 'not set', not 1 January 1970", () => {
  assert.equal(dateFromEpoch(0), null);
  assert.equal(dueDateOf({ id: 1, dates: [{ label: "Due:", timestamp: 0 }] }), null);
});

test("corrupt timestamps produce no date rather than an invalid one", () => {
  assert.equal(dateFromEpoch(null), null);
  assert.equal(dateFromEpoch("not a number"), null);
  assert.equal(dateFromEpoch(-1), null);
  assert.equal(dateFromEpoch(undefined), null);
});

test("a deadline just before midnight keeps its own day, in the college's timezone", () => {
  // THE BUG isoDate.js EXISTS FOR, pointed at deadlines. A 00:30 BST deadline is
  // 23:30 the previous day in UTC; slicing the UTC string dates the whole assessment a
  // day early, and every submission on the actual deadline day then reads as late.
  const bstJustAfterMidnight = Math.floor(Date.UTC(2026, 5, 10, 23, 30, 0) / 1000); // 00:30 BST on the 11th
  assert.equal(dateFromEpoch(bstJustAfterMidnight, "Europe/London"), "2026-06-11");
  // The same instant in UTC really is the 10th — proving the zone is doing the work.
  assert.equal(dateFromEpoch(bstJustAfterMidnight, "UTC"), "2026-06-10");
});

test("the map is keyed by course-module id, which is what Assessment stores", () => {
  const sections = [
    { modules: [{ id: 101, dates: [{ label: "Due:", timestamp: DUE_TS }] }] },
    { modules: [{ id: 202, dates: [{ label: "Opened:", timestamp: DUE_TS }] }] },
  ];
  const map = dueDatesByCmid(sections);
  assert.equal(map.get(101), "2026-11-15");
  // AND NOT PRESENT-AND-NULL. A caller writing map.get(cmid) into dueDate must get
  // `undefined` for an activity with no deadline, so it can tell "no deadline known"
  // from "the deadline is null" and refuse to overwrite a date somebody typed.
  assert.equal(map.has(202), false);
});

test("a course with no modules is an empty map, not a crash", () => {
  // The sync must survive an oddly-shaped course rather than abandoning the whole run.
  assert.equal(dueDatesByCmid(undefined).size, 0);
  assert.equal(dueDatesByCmid([]).size, 0);
  assert.equal(dueDatesByCmid([{}]).size, 0);
  assert.equal(dueDatesByCmid([{ modules: null }]).size, 0);
  assert.equal(dueDatesByCmid([{ modules: [{ dates: [{ label: "Due:", timestamp: DUE_TS }] }] }]).size, 0); // no id
});
