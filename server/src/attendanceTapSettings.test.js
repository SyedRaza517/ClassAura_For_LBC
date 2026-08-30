// The pure half of tap check-in's per-college settings: what the defaults are, and what
// a stored blob is allowed to change them to.
//
// No database. The DB-backed half lives in attendanceTapConfig.js, and the split is the
// point: the rules a college's attendance depends on are testable without one.
//
// Run with: node --test src/attendanceTapSettings.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULTS, SETTING_FIELDS, merge, MIN_QR_ROTATE_SECONDS, MAX_QR_ROTATE_SECONDS,
} = require("./attendanceTapSettings");

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

// ---------------------------------------------------------------------------
// The rotating QR code
// ---------------------------------------------------------------------------

test("QR ships OFF, independently of the sticker", () => {
  // Two capture methods, two switches. A college may want the stickers and not the
  // projector, or the projector and not the stickers, and inferring one from the other
  // would switch on a way of writing to the attendance record that nobody asked for.
  assert.equal(DEFAULTS.qrEnabled, false);
  assert.equal(DEFAULTS.enabled, false);
});

test("switching the stickers on does not switch the QR on", () => {
  const out = merge({ enabled: true });
  assert.equal(out.enabled, true);
  assert.equal(out.qrEnabled, false);
});

test("the rotation period defaults to thirty seconds", () => {
  assert.equal(DEFAULTS.qrRotateSeconds, 30);
});

test("a rotation shorter than the floor is raised to it", () => {
  // A one-second rotation is an outage that presents as "the QR never works": the code
  // has moved on before a phone can focus. The floor matters as much as the ceiling.
  assert.equal(merge({ qrRotateSeconds: 1 }).qrRotateSeconds, MIN_QR_ROTATE_SECONDS);
  assert.equal(merge({ qrRotateSeconds: 0 }).qrRotateSeconds, MIN_QR_ROTATE_SECONDS);
});

test("a rotation longer than the ceiling is capped", () => {
  // A code that lives for an hour is a permanent code with extra steps, which is the one
  // thing this whole design exists to avoid.
  assert.equal(merge({ qrRotateSeconds: 86_400 }).qrRotateSeconds, MAX_QR_ROTATE_SECONDS);
});

test("an unusable rotation is IGNORED, not reset", () => {
  // What the PATCH contract promises: a single bad key must not silently undo a
  // neighbouring setting somebody tuned last term.
  const current = { ...DEFAULTS, qrRotateSeconds: 45, qrEnabled: true };
  const out = merge({ qrRotateSeconds: "thirty" }, current);
  assert.equal(out.qrRotateSeconds, 45);
  assert.equal(out.qrEnabled, true);
});

test("a truthy non-boolean does not switch QR on", () => {
  assert.equal(merge({ qrEnabled: "false" }).qrEnabled, false);
  assert.equal(merge({ qrEnabled: 1 }).qrEnabled, false);
});

test("a FALSY non-boolean does not switch QR off", () => {
  // The direction that matters on a live college, and the one a truthy/falsy coercion
  // gets wrong silently: 0, "" and null are all reachable from a JSON body, and reading
  // any of them as consent to disable a running capture method would take a college's
  // attendance offline while answering 200 OK. Only an explicit `false` disables.
  const current = { ...DEFAULTS, qrEnabled: true };
  for (const bad of [0, "", null, undefined, NaN]) {
    assert.equal(merge({ qrEnabled: bad }, current).qrEnabled, true, `${JSON.stringify(bad)} must not disable QR`);
  }
  assert.equal(merge({ qrEnabled: false }, current).qrEnabled, false);
});

test("a FALSY non-boolean does not switch the stickers off either", () => {
  // The same protection attendanceTapSettings.js already claims in prose for `enabled` —
  // "{ enabled: null } is reachable from JSON and would switch a whole college OFF while
  // reporting success" — which nothing asserted until now. Same for staffTapEnabled.
  const current = { ...DEFAULTS, enabled: true, staffTapEnabled: true };
  for (const bad of [0, "", null, undefined, NaN]) {
    assert.equal(merge({ enabled: bad }, current).enabled, true, `${JSON.stringify(bad)} must not disable tap check-in`);
    assert.equal(merge({ staffTapEnabled: bad }, current).staffTapEnabled, true, `${JSON.stringify(bad)} must not disable staff taps`);
  }
});
