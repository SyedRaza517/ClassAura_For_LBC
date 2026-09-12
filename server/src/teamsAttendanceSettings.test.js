const { test } = require("node:test");
const assert = require("node:assert");
const { merge, DEFAULTS } = require("./teamsAttendanceSettings");

test("no stored settings yields the defaults, switched off", () => {
  assert.deepEqual(merge(undefined), { enabled: false, minAttendancePct: 50 });
  assert.equal(DEFAULTS.enabled, false);
});

test("a patch merges over a base without disturbing its neighbours", () => {
  assert.deepEqual(merge({ enabled: true }, DEFAULTS), { enabled: true, minAttendancePct: 50 });
});

test("an unusable value falls back to the base, never NaN or out of range", () => {
  assert.equal(merge({ minAttendancePct: "banana" }).minAttendancePct, 50);
  assert.equal(merge({ minAttendancePct: 0 }).minAttendancePct, 1);    // clamped: 0% would mark ghosts Present
  assert.equal(merge({ minAttendancePct: 250 }).minAttendancePct, 100); // clamped
  assert.equal(merge({ unknownKey: 1 }).unknownKey, undefined);         // allowlist
});
