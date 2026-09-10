// Two students, one handset — and, far more importantly, every case that is NOT that.
//
// The weighting here is the opposite of the usual one in this codebase. Elsewhere the
// refusals matter most because a permissive bug is invisible; here a FALSE POSITIVE is the
// dangerous direction, because the output of this rule is a flag on a named student's row
// that a member of staff may act on. Missing a collision costs a signal nobody had before.
// Inventing one puts an accusation next to a student who did nothing.
const test = require("node:test");
const assert = require("node:assert/strict");
const { sharedDeviceGroups } = require("./sharedDevice");

test("two students marked from one handset are flagged, both ways round", () => {
  const groups = sharedDeviceGroups([
    { studentId: "a", deviceId: "phone-1" },
    { studentId: "b", deviceId: "phone-1" },
  ]);
  assert.deepEqual(groups.get("a"), ["b"]);
  assert.deepEqual(groups.get("b"), ["a"], "the student whose phone it was is flagged too");
});

test("a whole register on separate handsets flags nobody", () => {
  const groups = sharedDeviceGroups([
    { studentId: "a", deviceId: "phone-1" },
    { studentId: "b", deviceId: "phone-2" },
    { studentId: "c", deviceId: "phone-3" },
  ]);
  assert.equal(groups.size, 0);
});

test("A REGISTER TAKEN BY A LECTURER IS NOT MASS PROXY ATTENDANCE", () => {
  // THE FAILURE THIS RULE MOST HAS TO AVOID. Every mark a member of staff sets has a null
  // device, which is the COMMON case rather than an edge one. Treating null as a value
  // would collect the entire class into one "shared handset" group and report an ordinary
  // register — the lecturer ticking thirty names — as thirty students sharing one phone.
  const groups = sharedDeviceGroups([
    { studentId: "a", deviceId: null },
    { studentId: "b", deviceId: null },
    { studentId: "c", deviceId: undefined },
    { studentId: "d" },
  ]);
  assert.equal(groups.size, 0);
});

test("...and a mix of hand-marked and self check-in only flags the real collision", () => {
  const groups = sharedDeviceGroups([
    { studentId: "a", deviceId: null },       // marked by the lecturer
    { studentId: "b", deviceId: null },       // marked by the lecturer
    { studentId: "c", deviceId: "phone-1" },  // checked in on their own phone
    { studentId: "d", deviceId: "phone-2" },
    { studentId: "e", deviceId: "phone-2" },  // ...and this is the pair
  ]);
  assert.deepEqual([...groups.keys()].sort(), ["d", "e"]);
});

test("three students on one handset each see the other two", () => {
  const groups = sharedDeviceGroups([
    { studentId: "a", deviceId: "phone-1" },
    { studentId: "b", deviceId: "phone-1" },
    { studentId: "c", deviceId: "phone-1" },
  ]);
  assert.deepEqual(groups.get("a").sort(), ["b", "c"]);
  assert.deepEqual(groups.get("c").sort(), ["a", "b"]);
});

test("nobody shares a handset with themselves", () => {
  // Unreachable through @@unique([sessionId, studentId]), but a caller passing marks from
  // two sessions would produce it, and "shared a phone with themselves" is a nonsense a
  // screen would render next to somebody's name.
  const groups = sharedDeviceGroups([
    { studentId: "a", deviceId: "phone-1" },
    { studentId: "a", deviceId: "phone-1" },
  ]);
  assert.equal(groups.size, 0);
});

test("two handsets, two pairs, kept apart", () => {
  const groups = sharedDeviceGroups([
    { studentId: "a", deviceId: "phone-1" },
    { studentId: "b", deviceId: "phone-1" },
    { studentId: "c", deviceId: "phone-2" },
    { studentId: "d", deviceId: "phone-2" },
  ]);
  assert.deepEqual(groups.get("a"), ["b"]);
  assert.deepEqual(groups.get("c"), ["d"]);
  assert.equal(groups.get("a").includes("c"), false, "the two pairs must not merge");
});

test("a student with no collision is ABSENT from the map, not present and empty", () => {
  // So a caller can write `groups.has(id)` and have it mean what it says. An empty array
  // is truthy, and a screen asking `if (groups.get(id))` would flag the whole register.
  const groups = sharedDeviceGroups([
    { studentId: "a", deviceId: "phone-1" },
    { studentId: "b", deviceId: "phone-1" },
    { studentId: "c", deviceId: "phone-3" },
  ]);
  assert.equal(groups.has("c"), false);
  assert.equal(groups.get("c"), undefined);
});

test("it never throws, whatever it is handed", () => {
  // It runs on the register read, which a lecturer opens with a room in front of them.
  for (const input of [undefined, null, [], [null], [undefined], [{}], "marks", 42, [{ deviceId: "x" }]]) {
    const groups = sharedDeviceGroups(input);
    assert.ok(groups instanceof Map, JSON.stringify(input));
  }
});
