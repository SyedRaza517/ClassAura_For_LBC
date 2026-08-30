// Tests for the three-layer settings merge: platform defaults, then what the college
// set for everyone, then what this member of staff set for themselves.
//
// No database. This file is pure.
//
// Run with: node --test src/timetabling/settingsDefaults.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULTS, mergeSettings, cleanInstitution, cleanUser } = require("./settingsDefaults");

test("with nothing stored, the platform defaults come back whole", () => {
  const got = mergeSettings(null, null);
  assert.equal(got.view, DEFAULTS.view);
  assert.deepEqual(got.days, DEFAULTS.days);
  assert.equal(got.periods.length, DEFAULTS.periods.length);
});

test("the college's settings win over the platform defaults", () => {
  const got = mergeSettings({ view: "day" }, null);
  assert.equal(got.view, "day");
});

test("the staff member's settings win over the college's", () => {
  const got = mergeSettings({ view: "day" }, { view: "month" });
  assert.equal(got.view, "month");
});

test("a layer that sets one key does not blank the others", () => {
  // Merge, not replace. A lecturer who hides the weekend must not thereby lose the
  // college's notice banner and colour choice.
  const got = mergeSettings({ view: "day", colourBy: "room" }, { view: "month" });
  assert.equal(got.view, "month");
  assert.equal(got.colourBy, "room");
});

test("THE NOTICE BANNER IS THE COLLEGE'S, AND A USER CANNOT SET IT", () => {
  // The banner carries compliance wording — the reference institution's says what
  // students must do to stay eligible for a maintenance loan. It is an institutional
  // statement, and a member of staff editing their own copy of it would be editing
  // what every reader of their timetable is told.
  const got = mergeSettings({ notice: { enabled: true, text: "College says" } },
                            { notice: { enabled: true, text: "I say" } });
  assert.equal(got.notice.text, "College says");
});

test("cleanUser drops the notice entirely", () => {
  assert.equal("notice" in cleanUser({ notice: { enabled: true, text: "x" }, view: "day" }), false);
});

test("unknown keys are dropped rather than stored", () => {
  // An allowlist, not a blocklist. sAdmission is the standing example of what the
  // other way costs: it stripped a fixed list of secrets, so every column added
  // afterwards shipped to the browser by default.
  const cleaned = cleanInstitution({ view: "day", isAdmin: true, __proto__: {}, nonsense: 1 });
  assert.deepEqual(Object.keys(cleaned), ["view"]);
});

test("an invalid view is dropped, not stored", () => {
  assert.deepEqual(cleanInstitution({ view: "spiral" }), {});
});

test("days must be ISO weekdays 1-7 and are de-duplicated and sorted", () => {
  assert.deepEqual(cleanInstitution({ days: [5, 1, 1, 9, 3, 0] }).days, [1, 3, 5]);
});

test("an empty day list is refused, because a timetable showing no days is a bug report", () => {
  assert.deepEqual(cleanInstitution({ days: [] }), {});
});

test("periods must be HH:MM pairs with end after start", () => {
  const ok = cleanInstitution({ periods: [{ start: "09:00", end: "10:00" }] });
  assert.deepEqual(ok.periods, [{ start: "09:00", end: "10:00" }]);
  assert.deepEqual(cleanInstitution({ periods: [{ start: "10:00", end: "09:00" }] }), {});
  assert.deepEqual(cleanInstitution({ periods: [{ start: "9:00", end: "10:00" }] }), {});
});

test("periods come back sorted, whatever order they were sent in", () => {
  const got = cleanInstitution({ periods: [{ start: "14:00", end: "15:00" }, { start: "09:00", end: "10:00" }] });
  assert.deepEqual(got.periods.map((p) => p.start), ["09:00", "14:00"]);
});

test("highlightChangedDays is clamped, not rejected", () => {
  // A number field a person types into. 0 means "do not highlight"; a negative or
  // absurd value is a slip, and clamping keeps their other edits in the same save.
  assert.equal(cleanUser({ highlightChangedDays: -5 }).highlightChangedDays, 0);
  assert.equal(cleanUser({ highlightChangedDays: 9999 }).highlightChangedDays, 90);
});

test("annotations keep only known fields, in the order given", () => {
  // The order IS the setting — it is what prints first inside an event tile.
  const got = cleanUser({ annotations: ["room", "nonsense", "title"] });
  assert.deepEqual(got.annotations, ["room", "title"]);
});
