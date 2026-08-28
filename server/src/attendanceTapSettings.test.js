// The pure half of tap check-in's per-college settings: what the defaults are, and what
// a stored blob is allowed to change them to.
//
// No database. The DB-backed half lives in attendanceTapConfig.js, and the split is the
// point: the rules a college's attendance depends on are testable without one.
//
// Run with: node --test src/attendanceTapSettings.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULTS, SETTING_FIELDS, merge } = require("./attendanceTapSettings");

test("an unconfigured college gets the defaults, and the feature is OFF", () => {
  // Shipping enabled would switch this on at every college on the next deploy.
  // Attendance emails ship off for the same reason.
  const s = merge(null);
  assert.equal(s.enabled, false);
  assert.equal(s.lateAfterMins, 15);
  assert.equal(s.earlyGraceMins, 0);
  assert.equal(s.armSeconds, 60);
  assert.equal(s.staffTapEnabled, true);
});

test("a stored value overrides just that key, leaving the rest at the defaults", () => {
  const s = merge({ lateAfterMins: 5 });
  assert.equal(s.lateAfterMins, 5);
  assert.equal(s.earlyGraceMins, DEFAULTS.earlyGraceMins);
  assert.equal(s.enabled, false);
});

test("a key nobody defined is dropped, not carried through", () => {
  // The allowlist is on the way OUT, so a column or key added tomorrow is private until
  // someone publishes it deliberately.
  const s = merge({ enabled: true, secretInternalNote: "do not ship" });
  assert.equal(s.enabled, true);
  assert.equal("secretInternalNote" in s, false);
  assert.deepEqual(Object.keys(s).sort(), [...SETTING_FIELDS].sort());
});

test("a nonsense value falls back to the default rather than poisoning the maths", () => {
  // A negative grace would accept taps AFTER a lecture ended; a string would make every
  // comparison NaN and silently mark nobody, which looks exactly like a quiet day.
  assert.equal(merge({ lateAfterMins: -5 }).lateAfterMins, DEFAULTS.lateAfterMins);
  assert.equal(merge({ earlyGraceMins: "soon" }).earlyGraceMins, DEFAULTS.earlyGraceMins);
  assert.equal(merge({ armSeconds: null }).armSeconds, DEFAULTS.armSeconds);
});

test("minutes are capped, so one typo cannot open a register all day", () => {
  // 600 in earlyGraceMins would accept a tap ten hours before the class started.
  assert.equal(merge({ earlyGraceMins: 600 }).earlyGraceMins, 120);
  assert.equal(merge({ lateAfterMins: 9999 }).lateAfterMins, 120);
});

test("enabled must be a real boolean — a truthy string is a mistake, not consent", () => {
  assert.equal(merge({ enabled: "false" }).enabled, false);
  assert.equal(merge({ enabled: 1 }).enabled, false);
  assert.equal(merge({ enabled: true }).enabled, true);
});

test("merge never mutates DEFAULTS, however often it is called", () => {
  // DEFAULTS is frozen, but a shallow copy that shared a nested value would still let
  // one college's settings leak into the next request's. Cheap to pin, and the failure
  // would be almost impossible to reproduce from a bug report.
  merge({ enabled: true, lateAfterMins: 99 });
  assert.equal(DEFAULTS.enabled, false);
  assert.equal(DEFAULTS.lateAfterMins, 15);
  assert.notEqual(merge(null), merge(null)); // a fresh object each time
});
