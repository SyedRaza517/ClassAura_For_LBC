// Run with: node --test src/timetabling/seriesDates.test.js   (from server/)
const { test } = require("node:test");
const assert = require("node:assert");
const { seriesDates, MAX_DATES } = require("./recurrence");

// 2026-09-07 is a Monday. Everything below is anchored on that.
const MON = "2026-09-07";

test("one weekday gives a weekly series", () => {
  assert.deepEqual(seriesDates(MON, "2026-09-28", [1]), ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]);
});

test("SEVERAL WEEKDAYS COME BACK IN DATE ORDER, not grouped by day", () => {
  // The whole point of this over weeklyDates. A reader scanning the preview expects a
  // calendar, and Mon/Mon/Mon/Thu/Thu/Thu reads as two separate things.
  assert.deepEqual(seriesDates(MON, "2026-09-17", [1, 4]),
    ["2026-09-07", "2026-09-10", "2026-09-14", "2026-09-17"]);
});

test("no days named falls back to the start date's own weekday", () => {
  // A caller that passes nothing must get the obvious single-day series. Returning
  // an empty list would silently create no classes at all.
  assert.deepEqual(seriesDates(MON, "2026-09-21", []), ["2026-09-07", "2026-09-14", "2026-09-21"]);
  assert.deepEqual(seriesDates(MON, "2026-09-21"), ["2026-09-07", "2026-09-14", "2026-09-21"]);
});

test("Sunday is 7, not 0", () => {
  // 2026-09-13 is the Sunday in that week. ISO says 7; JS getUTCDay says 0, and a
  // module that leaked the JS convention would return nothing for a Sunday class and
  // every Sunday for a Monday one.
  assert.deepEqual(seriesDates("2026-09-13", "2026-09-20", [7]), ["2026-09-13", "2026-09-20"]);
  assert.deepEqual(seriesDates("2026-09-13", "2026-09-20", [0]), ["2026-09-13", "2026-09-20"],
    "0 is not a valid ISO day, so it is dropped and the fallback applies");
});

test("skipped dates are dropped, NOT shifted to the next week", () => {
  // Shifting would push the rest of the term along by seven days — a bank holiday in
  // week 2 silently moving weeks 3 to 12.
  const out = seriesDates(MON, "2026-09-28", [1], { skip: ["2026-09-14"] });
  assert.deepEqual(out, ["2026-09-07", "2026-09-21", "2026-09-28"]);
});

test("the range is inclusive at both ends", () => {
  assert.deepEqual(seriesDates(MON, MON, [1]), [MON]);
});

test("an end before the start gives nothing rather than throwing", () => {
  assert.deepEqual(seriesDates("2026-09-28", MON, [1]), []);
});

test("a weekday that never occurs in the range gives nothing", () => {
  // Tuesday, in a range covering only Monday. An empty series is the honest answer;
  // silently widening to the nearest day would place classes nobody asked for.
  assert.deepEqual(seriesDates(MON, MON, [2]), []);
});

test("THE SPRING CLOCK CHANGE DOES NOT SLIP THE SERIES", () => {
  // BST begins 2026-03-29. Local-time arithmetic lands on 23:00 the previous day and
  // turns the rest of a term of Tuesday lectures into Monday lectures. All the dates
  // below must stay Tuesdays.
  const out = seriesDates("2026-03-24", "2026-04-14", [2]);
  assert.deepEqual(out, ["2026-03-24", "2026-03-31", "2026-04-07", "2026-04-14"]);
});

test("the autumn clock change does not duplicate a date", () => {
  // GMT resumes 2026-10-25.
  const out = seriesDates("2026-10-20", "2026-11-10", [2]);
  assert.deepEqual(out, ["2026-10-20", "2026-10-27", "2026-11-03", "2026-11-10"]);
});

test("a runaway end date is capped rather than generating forever", () => {
  const out = seriesDates("2026-01-01", "2099-12-31", [1, 2, 3, 4, 5]);
  assert.equal(out.length, MAX_DATES);
});

test("garbage days are ignored rather than throwing", () => {
  // Comes off a JSON body, so it can be anything.
  assert.deepEqual(seriesDates(MON, "2026-09-14", [1, "x", null, 99, 2.5]), ["2026-09-07", "2026-09-14"]);
});

test("an invalid start date gives nothing rather than an Invalid Date crash", () => {
  assert.deepEqual(seriesDates("not-a-date", "2026-09-14", [1]), []);
});
