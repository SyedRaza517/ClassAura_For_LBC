// Run with: node --test src/timetabling/registerRules.test.js   (from server/)
const { test } = require("node:test");
const assert = require("node:assert");
const { registerAction } = require("./registerRules");

const event = { date: "2026-09-15", startTime: "09:00", endTime: "15:00", roomId: "r1" };
const base = { published: true, createRegisters: true, unitId: "u1", existing: null, event };

test("a published unit-bearing event with no register creates one", () => {
  assert.equal(registerAction(base).action, "create");
});

test("an unpublished event creates nothing", () => {
  assert.equal(registerAction({ ...base, published: false }).action, "skip");
});

test("an event with the register option off creates nothing", () => {
  assert.equal(registerAction({ ...base, createRegisters: false }).action, "skip");
});

test("an event with no unit cannot have a register, and says so", () => {
  const r = registerAction({ ...base, unitId: null });
  assert.equal(r.action, "skip");
  assert.match(r.reason, /not a taught session/i);
});

test("the unitless reason wins over the draft reason", () => {
  // A draft workshop is unitless AND unpublished. "Not a taught session" is the
  // permanent fact and the one worth showing; "still a draft" implies publishing
  // would fix it, which it never will.
  const r = registerAction({ ...base, unitId: null, published: false });
  assert.match(r.reason, /not a taught session/i);
});

test("an unmarked register follows the event when the event moves", () => {
  const existing = { id: "s1", hasMarks: false, date: "2026-09-15", startTime: "10:00", endTime: "13:00", roomId: null };
  assert.equal(registerAction({ ...base, existing }).action, "update");
});

test("an unmarked register that already matches needs no write", () => {
  const existing = { id: "s1", hasMarks: false, ...event };
  assert.equal(registerAction({ ...base, existing }).action, "skip");
});

test("A MARKED REGISTER IS NEVER MOVED", () => {
  // The rule the whole feature turns on. Editing a calendar entry must not rewrite
  // attendance evidence.
  const existing = { id: "s1", hasMarks: true, date: "2026-09-15", startTime: "10:00", endTime: "13:00", roomId: null };
  const r = registerAction({ ...base, existing });
  assert.equal(r.action, "freeze");
  assert.match(r.reason, /already been taken/i);
});

test("a marked register that still matches the event is not reported as diverged", () => {
  // Otherwise every publish of an unchanged term reports every taken register as a
  // problem, and the real divergences are lost in the noise.
  const existing = { id: "s1", hasMarks: true, ...event };
  assert.equal(registerAction({ ...base, existing }).action, "skip");
});

test("a room moving alone is enough to diverge", () => {
  // Room is part of the comparison, not just the times: a class relocated after the
  // register was taken is exactly the case a lecturer needs told about.
  const existing = { id: "s1", hasMarks: true, ...event, roomId: "r2" };
  assert.equal(registerAction({ ...base, existing }).action, "freeze");
});

test("a room going from null to set counts as a change", () => {
  // null and "r1" are different, and coercion must not make them equal — an unmarked
  // register that never had a room should gain one.
  const existing = { id: "s1", hasMarks: false, ...event, roomId: null };
  assert.equal(registerAction({ ...base, existing }).action, "update");
});

test("a missing roomId key is treated as null, not as a change", () => {
  // A select that omitted roomId must not make every register look diverged.
  const existing = { id: "s1", hasMarks: true, date: "2026-09-15", startTime: "09:00", endTime: "15:00" };
  const r = registerAction({ ...base, event: { ...event, roomId: null }, existing });
  assert.equal(r.action, "skip");
});
