// Tests for the clash checker — the arithmetic that tells a timetabler two classes
// cannot both happen.
//
// The rules under test are the ones every product in the field agrees on (see
// docs/staff-roadmap/2026-09-13-research-and-options.md §3, verified against EDT,
// TimeTabler, Untis and UniTime): a STAFF member, a ROOM or a GROUP in two places at
// an overlapping time on the same date is a clash; a class ENDING exactly when the
// next begins is NOT (09:00–10:00 then 10:00–11:00 is a timetable, not a conflict);
// different dates never clash however identical the times; and a resource that is
// simply absent (no room recorded) clashes with nothing — null is not a room.
//
// Run with: node --test   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { findClashes } = require("./clashes");

const ev = (patch) => ({
  id: patch.id, date: "2026-09-21", start: "09:00", end: "11:00", title: patch.id,
  published: true, roomId: null, staffIds: [], groupIds: [], ...patch,
});

test("the same staff member in two overlapping classes is one staff clash", () => {
  const clashes = findClashes([
    ev({ id: "a", staffIds: ["s1"], start: "09:00", end: "11:00" }),
    ev({ id: "b", staffIds: ["s1"], start: "10:00", end: "12:00" }),
  ]);
  assert.equal(clashes.length, 1);
  assert.equal(clashes[0].kind, "staff");
  assert.equal(clashes[0].resourceId, "s1");
  assert.deepEqual([clashes[0].aId, clashes[0].bId].sort(), ["a", "b"]);
  assert.equal(clashes[0].from, "10:00");
  assert.equal(clashes[0].to, "11:00");
});

test("back-to-back is not a clash: ending at 10:00 and starting at 10:00 is a timetable", () => {
  const clashes = findClashes([
    ev({ id: "a", staffIds: ["s1"], start: "09:00", end: "10:00" }),
    ev({ id: "b", staffIds: ["s1"], start: "10:00", end: "11:00" }),
  ]);
  assert.deepEqual(clashes, []);
});

test("identical times on different dates never clash", () => {
  const clashes = findClashes([
    ev({ id: "a", staffIds: ["s1"], date: "2026-09-21" }),
    ev({ id: "b", staffIds: ["s1"], date: "2026-09-22" }),
  ]);
  assert.deepEqual(clashes, []);
});

test("rooms and groups clash by the same rule, and a null room clashes with nothing", () => {
  const clashes = findClashes([
    ev({ id: "a", roomId: "r1", groupIds: ["g1"] }),
    ev({ id: "b", roomId: "r1", groupIds: ["g1"], start: "10:30" }),
    ev({ id: "c", roomId: null, start: "09:30" }),
    ev({ id: "d", roomId: null, start: "09:45" }),
  ]);
  const kinds = clashes.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["group", "room"], `got ${JSON.stringify(clashes)}`);
});

test("one pair sharing staff AND room AND group reports all three, not one merged mystery", () => {
  const clashes = findClashes([
    ev({ id: "a", staffIds: ["s1"], roomId: "r1", groupIds: ["g1"] }),
    ev({ id: "b", staffIds: ["s1"], roomId: "r1", groupIds: ["g1"], start: "10:00" }),
  ]);
  assert.deepEqual(clashes.map((c) => c.kind).sort(), ["group", "room", "staff"]);
});

test("three classes piled on one room report every overlapping pair", () => {
  const clashes = findClashes([
    ev({ id: "a", roomId: "r1", start: "09:00", end: "12:00" }),
    ev({ id: "b", roomId: "r1", start: "09:30", end: "10:30" }),
    ev({ id: "c", roomId: "r1", start: "10:00", end: "11:00" }),
  ]);
  assert.equal(clashes.length, 3); // a-b, a-c, b-c
});

test("two staff on one event each clash separately with their own other classes", () => {
  const clashes = findClashes([
    ev({ id: "a", staffIds: ["s1", "s2"] }),
    ev({ id: "b", staffIds: ["s1"], start: "10:00" }),
    ev({ id: "c", staffIds: ["s2"], start: "10:30" }),
  ]);
  assert.equal(clashes.filter((c) => c.resourceId === "s1").length, 1);
  assert.equal(clashes.filter((c) => c.resourceId === "s2").length, 1);
});

test("the same pair is reported once per resource, not once per scan order", () => {
  // Regression guard: a and b share the room; swapping input order must not change
  // the count or the pair's identity.
  const forward = findClashes([ev({ id: "a", roomId: "r1" }), ev({ id: "b", roomId: "r1", start: "10:00" })]);
  const backward = findClashes([ev({ id: "b", roomId: "r1", start: "10:00" }), ev({ id: "a", roomId: "r1" })]);
  assert.equal(forward.length, 1);
  assert.equal(backward.length, 1);
  assert.deepEqual([forward[0].aId, forward[0].bId].sort(), [backward[0].aId, backward[0].bId].sort());
});

test("an event with no times, or end before start, is skipped rather than guessed at", () => {
  const clashes = findClashes([
    ev({ id: "a", roomId: "r1", start: "", end: "" }),
    ev({ id: "b", roomId: "r1" }),
    ev({ id: "c", roomId: "r1", start: "11:00", end: "09:00" }),
  ]);
  assert.deepEqual(clashes, []);
});
