// Tests for the timetable's date arithmetic and grid placement.
//
// This is the ONLY tested file in the client, and it is tested because the server
// half already produced a clock-change bug in exactly this arithmetic
// (server/src/timetabling/recurrence.test.js pins it) and this module repeats the
// shape. client/package.json has "type": "module", so node runs these directly.
//
// Run with: node --test client/src/timetableView.test.js   (from the repo root)
import test from "node:test";
import assert from "node:assert/strict";

import {
  windowFor, shiftAnchor, datesIn, isoDay, minutes,
  placeEvent, colourOf, annotationLines, changedWithin, RANGE_LABEL,
} from "./timetableView.js";

const PERIODS = [
  { start: "09:00", end: "10:00" }, { start: "10:00", end: "11:00" },
  { start: "11:00", end: "12:00" }, { start: "12:00", end: "13:00" },
];

/* ------------------------------------------------------------- weekdays -- */

test("isoDay puts Monday at 1 and Sunday at 7", () => {
  assert.equal(isoDay("2026-08-31"), 1);  // a Monday
  assert.equal(isoDay("2026-09-06"), 7);  // the Sunday after
});

/* --------------------------------------------------------------- window -- */

test("a week window runs Monday to Sunday, whatever day the anchor is", () => {
  assert.deepEqual(windowFor("week", "2026-09-02"), { from: "2026-08-31", to: "2026-09-06" });
  assert.deepEqual(windowFor("week", "2026-08-31"), { from: "2026-08-31", to: "2026-09-06" });
  assert.deepEqual(windowFor("week", "2026-09-06"), { from: "2026-08-31", to: "2026-09-06" });
});

test("a day window is that one day", () => {
  assert.deepEqual(windowFor("day", "2026-09-02"), { from: "2026-09-02", to: "2026-09-02" });
});

test("a month window covers WHOLE weeks, so the grid has no ragged edge", () => {
  // September 2026 starts on a Tuesday, so the grid must open on Mon 31 Aug.
  assert.deepEqual(windowFor("month", "2026-09-15"), { from: "2026-08-31", to: "2026-10-04" });
});

test("a timeline window is two weeks from the anchor's Monday", () => {
  assert.deepEqual(windowFor("timeline", "2026-09-02"), { from: "2026-08-31", to: "2026-09-13" });
});

/* ----------------------------------------------------------- navigation -- */

test("next and previous move by the view's own unit", () => {
  assert.equal(shiftAnchor("day", "2026-09-02", 1), "2026-09-03");
  assert.equal(shiftAnchor("week", "2026-09-02", 1), "2026-09-09");
  assert.equal(shiftAnchor("week", "2026-09-02", -1), "2026-08-26");
});

test("the big jump moves a month in day/week and a year in month", () => {
  assert.equal(shiftAnchor("week", "2026-09-02", 1, true), "2026-10-02");
  assert.equal(shiftAnchor("month", "2026-09-02", 1, true), "2027-09-02");
});

test("a month step from the 31st does not skip a month", () => {
  // 31 Jan + 1 month is 31 Feb, which JS silently rolls into March. A user pressing
  // "next month" on the 31st would then see March and never February.
  assert.equal(shiftAnchor("month", "2026-01-31", 1), "2026-02-28");
});

test("stepping survives the spring clock change without drifting a day", () => {
  // 29 March 2026 is when BST starts. Local-time arithmetic lands on 23:00 the
  // previous day and slips every later date back one.
  assert.equal(shiftAnchor("day", "2026-03-28", 1), "2026-03-29");
  assert.equal(shiftAnchor("week", "2026-03-23", 1), "2026-03-30");
});

/* ---------------------------------------------------------------- dates -- */

test("datesIn returns every date in the window", () => {
  assert.deepEqual(datesIn("2026-09-01", "2026-09-04", [1, 2, 3, 4, 5, 6, 7]),
    ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
});

test("datesIn drops the weekdays the reader has switched off", () => {
  // A lecturer who hides Saturday and Sunday must not get two empty columns.
  assert.deepEqual(datesIn("2026-08-31", "2026-09-06", [1, 2, 3, 4, 5]),
    ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
});

test("datesIn with no allowed days returns nothing rather than everything", () => {
  // Failing closed. An empty list is a settings bug, and showing the whole week
  // would hide it; showing nothing is visibly wrong and gets reported.
  assert.deepEqual(datesIn("2026-08-31", "2026-09-06", []), []);
});

/* -------------------------------------------------------------- placing -- */

test("minutes parses HH:MM", () => {
  assert.equal(minutes("09:30"), 570);
  assert.equal(minutes("00:00"), 0);
});

test("an event fills the fraction of the grid its times cover", () => {
  // The grid runs 09:00-13:00 = 240 minutes. 10:00-11:00 starts a quarter in and
  // covers a quarter.
  const p = placeEvent({ start: "10:00", end: "11:00" }, PERIODS);
  assert.equal(Math.round(p.topPct), 25);
  assert.equal(Math.round(p.heightPct), 25);
});

test("an event outside the shown periods is not placed at all", () => {
  // Not clamped to the edge. A 20:00 class drawn on the last row of a grid that
  // stops at 13:00 is a lie about when it happens; leaving it out is honest, and
  // the reader's own settings are what excluded it.
  assert.equal(placeEvent({ start: "20:00", end: "21:00" }, PERIODS), null);
});

test("an event that starts before the grid is clipped, not dropped", () => {
  // It genuinely overlaps the visible hours, so it must appear — starting at the top.
  const p = placeEvent({ start: "08:00", end: "10:00" }, PERIODS);
  assert.equal(Math.round(p.topPct), 0);
  assert.equal(Math.round(p.heightPct), 25);
});

/* --------------------------------------------------------------- colour -- */

test("colour follows the chosen dimension, not the event", () => {
  const e = { categoryColour: "#111111", roomId: "r1", unitId: "u1", groups: [{ id: "g1" }] };
  assert.equal(colourOf(e, "category"), "#111111");
  // The others are derived from the id, so the same room is the same colour every
  // time without anybody having to assign one.
  assert.equal(colourOf(e, "room"), colourOf({ ...e, categoryColour: "#999999" }, "room"));
  assert.notEqual(colourOf(e, "room"), colourOf({ ...e, roomId: "r2" }, "room"));
});

test("an event with nothing on the chosen dimension still gets a colour", () => {
  // Never undefined — an undefined colour renders as an invisible event.
  assert.match(colourOf({}, "room"), /^#|^var\(/);
});

/* ---------------------------------------------------------- annotations -- */

test("annotations print in the order given, skipping what the event lacks", () => {
  const e = { title: "Systems", unitCode: "U1", room: "101 [Harrow]", staff: [{ name: "A B" }], groups: [], category: null };
  assert.deepEqual(annotationLines(e, ["title", "room", "category", "staff", "group"]),
    ["Systems", "101 [Harrow]", "A B"]);
});

test("reordering annotations reorders the output, because the order IS the setting", () => {
  const e = { title: "Systems", room: "101" };
  assert.deepEqual(annotationLines(e, ["room", "title"]), ["101", "Systems"]);
});

/* ------------------------------------------------------------- recently -- */

test("recently-changed is computed from the timestamp at render time", () => {
  // Never a stored day count: that would be wrong by the next morning with nothing
  // to correct it.
  const e = { changedAt: "2026-09-01T10:00:00.000Z" };
  assert.equal(changedWithin(e, 7, "2026-09-03"), true);
  assert.equal(changedWithin(e, 1, "2026-09-03"), false);
});

test("zero days means the highlight is off, not 'changed today'", () => {
  assert.equal(changedWithin({ changedAt: "2026-09-03T10:00:00.000Z" }, 0, "2026-09-03"), false);
});

test("a DAY view shows the day you navigated to, even if that weekday is switched off", () => {
  // 30 Aug 2026 is a Sunday, and the default day list is Mon-Fri. Filtering a Day
  // view by the weekday setting deleted the only date on screen and left the reader
  // staring at "no days are switched on" — on a weekend, for a setting they never
  // knowingly chose. The list decides which COLUMNS a week grid shows; navigating to
  // a specific date is an explicit request and outranks it.
  assert.deepEqual(datesIn("2026-08-30", "2026-08-30", [1, 2, 3, 4, 5], "day"), ["2026-08-30"]);
  // A week view still hides it.
  assert.equal(datesIn("2026-08-24", "2026-08-30", [1, 2, 3, 4, 5], "week").includes("2026-08-30"), false);
});

test("the range label prints the month once inside a month, twice across one", () => {
  assert.equal(RANGE_LABEL("week", "2026-08-24", "2026-08-30"), "24 - 30 Aug 26");
  // "Sept", not "Sep" — that is what en-GB actually produces for September in
  // current ICU, and the assertion is pinned to the real output rather than to what
  // the abbreviation "ought" to be.
  assert.equal(RANGE_LABEL("week", "2026-08-31", "2026-09-06"), "31 Aug - 6 Sept 26");
  assert.equal(RANGE_LABEL("month", "2026-08-31", "2026-10-04"), "August 2026");
});
