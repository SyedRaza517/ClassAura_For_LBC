// Tests for interval overlap — the arithmetic behind clash detection.
//
// No database. This file is pure.
//
// Run with: node --test src/timetabling/overlap.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { overlaps, findClashes } = require("./overlap");

const ev = (id, date, startTime, endTime) => ({ id, date, startTime, endTime });

test("two identical ranges overlap", () => {
  assert.equal(overlaps("09:00", "11:00", "09:00", "11:00"), true);
});

test("a range wholly inside another overlaps", () => {
  assert.equal(overlaps("09:00", "12:00", "10:00", "11:00"), true);
  assert.equal(overlaps("10:00", "11:00", "09:00", "12:00"), true);
});

test("partial overlap at either end counts", () => {
  assert.equal(overlaps("09:00", "11:00", "10:00", "12:00"), true);
  assert.equal(overlaps("10:00", "12:00", "09:00", "11:00"), true);
});

test("BACK-TO-BACK IS NOT A CLASH", () => {
  // The single most important case. Intervals are half-open: an event ending at
  // 11:00 and one starting at 11:00 do not collide. Consecutive classes are the
  // normal shape of a teaching day, and a warning that fires on every consecutive
  // pair is a warning nobody reads — which is the same as having no warning at all,
  // except that it also hides the real ones.
  assert.equal(overlaps("09:00", "11:00", "11:00", "13:00"), false);
  assert.equal(overlaps("11:00", "13:00", "09:00", "11:00"), false);
});

test("ranges that do not touch do not overlap", () => {
  assert.equal(overlaps("09:00", "10:00", "14:00", "15:00"), false);
});

test("times compare as strings, so a single-digit hour must be zero-padded", () => {
  // "9:00" < "10:00" is FALSE lexicographically, so an unpadded time would silently
  // compare wrong. The route layer validates HH:MM; this documents why it must.
  assert.equal(overlaps("09:00", "10:00", "09:30", "10:30"), true);
});

test("findClashes ignores events on a different date", () => {
  const found = findClashes(ev(null, "2026-09-01", "09:00", "11:00"), [
    ev("a", "2026-09-02", "09:00", "11:00"),
  ]);
  assert.deepEqual(found, []);
});

test("findClashes returns the colliding events", () => {
  const found = findClashes(ev(null, "2026-09-01", "09:00", "11:00"), [
    ev("a", "2026-09-01", "10:00", "12:00"),
    ev("b", "2026-09-01", "11:00", "12:00"),
    ev("c", "2026-09-01", "08:00", "09:00"),
  ]);
  assert.deepEqual(found.map((e) => e.id), ["a"]);
});

test("an event never clashes with ITSELF", () => {
  // Editing an event re-checks it against everything already stored, and that set
  // includes the row being edited. Without this, saving an event without moving it
  // would report the event double-booking its own room.
  const found = findClashes(ev("a", "2026-09-01", "09:00", "11:00"), [
    ev("a", "2026-09-01", "09:00", "11:00"),
  ]);
  assert.deepEqual(found, []);
});
