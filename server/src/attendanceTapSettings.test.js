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
  DEFAULTS, SETTING_FIELDS, merge, MIN_QR_ROTATE_SECONDS, MAX_QR_ROTATE_SECONDS, MAX_NETWORKS,
} = require("./attendanceTapSettings");
const { MAX_RADIUS_METRES } = require("./presence");
const { GRACE_SECONDS } = require("./attendanceQr");

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

test("QR ships ON and the stickers ship OFF, which is the whole point of two switches", () => {
  // Changed deliberately on 4 Sep 2026; attendanceTapSettings.js carries the reasoning.
  // QR needs nothing bought or installed and is the capability the college is buying, so
  // it is on. The stickers need hardware somebody has to place, and a capture method
  // nobody has installed must not appear to be running, so they stay off.
  assert.equal(DEFAULTS.qrEnabled, true);
  assert.equal(DEFAULTS.enabled, false);
});

test("the two switches move independently, in both directions", () => {
  // Switching the stickers on says nothing about the code, and switching the code off
  // says nothing about the stickers. Inferring either from the other would change a way
  // of writing to the attendance record that nobody touched.
  const stickersOn = merge({ enabled: true });
  assert.equal(stickersOn.enabled, true);
  assert.equal(stickersOn.qrEnabled, true, "the QR default must survive a sticker change");

  const qrOff = merge({ qrEnabled: false });
  assert.equal(qrOff.qrEnabled, false, "a college must be able to switch the code off");
  assert.equal(qrOff.enabled, false, "and that must not switch the stickers on");

  const qrOffStickersOn = merge({ qrEnabled: false, enabled: true });
  assert.equal(qrOffStickersOn.qrEnabled, false);
  assert.equal(qrOffStickersOn.enabled, true);
});

test("the rotation period defaults to twenty seconds", () => {
  // Was thirty until 11 Sep 2026. Pinned rather than merely defaulted because it is the
  // one number that says how long a photographed screen keeps working, and a change to it
  // should be a deliberate edit to a test, not a quiet edit to a constant.
  assert.equal(DEFAULTS.qrRotateSeconds, 20);
});

test("...and a code cannot outlive that setting by more than the grace", () => {
  // The setting and the verifier are in two files, and the number a college reads on the
  // settings screen is only honest if the second one agrees with it. This asserts the
  // relationship rather than either value: a code lives for the rotation plus the grace,
  // and the grace is a few seconds rather than another whole window. Widen GRACE_SECONDS
  // to the rotation period and this fails, which is the point.
  assert.ok(GRACE_SECONDS < DEFAULTS.qrRotateSeconds / 2,
    `a ${GRACE_SECONDS}s grace on a ${DEFAULTS.qrRotateSeconds}s rotation is most of another window`);
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

test("a non-boolean is IGNORED, so it can neither switch QR on nor off", () => {
  // Tested from BOTH starting points on purpose. This assertion used to read
  // `=== false` against a default of false, so it passed while proving nothing: a rule
  // that says "ignore junk" and a rule that says "junk means off" were indistinguishable.
  // `{ qrEnabled: "false" }` and `{ qrEnabled: 1 }` are both reachable from any JSON
  // client, and neither is an instruction.
  const on = { ...DEFAULTS, qrEnabled: true };
  const off = { ...DEFAULTS, qrEnabled: false };
  for (const junk of ["false", "true", 1, 0, null, {}, []]) {
    assert.equal(merge({ qrEnabled: junk }, on).qrEnabled, true, `${JSON.stringify(junk)} switched it off`);
    assert.equal(merge({ qrEnabled: junk }, off).qrEnabled, false, `${JSON.stringify(junk)} switched it on`);
  }
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

/* ----- is the phone in the building: what the college is allowed to configure ----- */

test("an unconfigured college has BOTH presence checks off and no networks", () => {
  // The same reasoning as `enabled` above. A college that has never opened this screen
  // must behave exactly as it did before these checks existed — and, crucially, must not
  // acquire a rule that refuses its students because a deploy shipped one.
  const s = merge(null);
  assert.equal(s.networkCheck, false);
  assert.equal(s.geofenceCheck, false);
  assert.deepEqual(s.allowedNetworks, []);
  assert.equal(s.geofenceRadiusM, 250);
});

test("a FALSY non-boolean does not switch a presence check off", () => {
  // These two now protect a college's attendance rules, so the failure is the opposite
  // shape from the others: a stray null must not QUIETLY REMOVE a control an
  // administrator switched on, while answering 200 OK.
  const current = { ...DEFAULTS, networkCheck: true, geofenceCheck: true };
  for (const bad of [0, "", null, undefined, NaN, "false"]) {
    assert.equal(merge({ networkCheck: bad }, current).networkCheck, true, `${JSON.stringify(bad)}`);
    assert.equal(merge({ geofenceCheck: bad }, current).geofenceCheck, true, `${JSON.stringify(bad)}`);
  }
  assert.equal(merge({ networkCheck: false }, current).networkCheck, false, "an explicit false still works");
});

test("a college's ranges are kept as typed, so the screen shows what they wrote", () => {
  const s = merge({ allowedNetworks: ["203.0.113.0/24", " 198.51.100.7 "] });
  assert.deepEqual(s.allowedNetworks, ["203.0.113.0/24", "198.51.100.7"]);
});

test("ONE BAD LINE DOES NOT THROW AWAY THE GOOD ONES", () => {
  // A college pasting four ranges off a network diagram will get one wrong. Refusing the
  // whole save, or keeping none, punishes the typo by taking check-in down for everybody.
  const s = merge({ allowedNetworks: ["203.0.113.0/24", "nonsense", "198.51.100.7", null, 42] });
  assert.deepEqual(s.allowedNetworks, ["203.0.113.0/24", "198.51.100.7"]);
});

test("...but a list where EVERY line is bad comes back empty, not ignored", () => {
  // And empty-with-the-check-on refuses everybody by name in presence.js, which is the
  // point: a college whose whole list is nonsense finds out on the first check-in rather
  // than running unprotected while the screen says the network is enforced.
  assert.deepEqual(merge({ allowedNetworks: ["nonsense", "1.2.3.4/99"] }).allowedNetworks, []);
});

test("the same network typed twice is stored once", () => {
  // Deduplicated on the parsed form: these are three ways of writing one network.
  const s = merge({ allowedNetworks: ["203.0.113.0/24", "203.0.113.7/24", "203.0.113.0/24"] });
  assert.equal(s.allowedNetworks.length, 1);
});

test("a paste accident is capped rather than walked on every check-in", () => {
  const many = Array.from({ length: MAX_NETWORKS + 20 }, (_, i) => `10.${i}.0.0/24`);
  assert.equal(merge({ allowedNetworks: many }).allowedNetworks.length, MAX_NETWORKS);
});

test("something that is not an array at all leaves the college's list alone", () => {
  // A shape error rather than a content one, so the PATCH contract applies: ignored, not
  // reset. Sending `allowedNetworks: null` must not silently empty a configured list and
  // — with the check on — lock the college out.
  const current = { ...DEFAULTS, allowedNetworks: ["203.0.113.0/24"] };
  for (const bad of [null, undefined, "203.0.113.0/24", {}, 42]) {
    assert.deepEqual(merge({ allowedNetworks: bad }, current).allowedNetworks, ["203.0.113.0/24"], `${JSON.stringify(bad)}`);
  }
});

test("an unusable radius is ignored rather than resetting a chosen one", () => {
  const current = { ...DEFAULTS, geofenceRadiusM: 400 };
  for (const bad of [null, undefined, "200", NaN, -5, {}]) {
    assert.equal(merge({ geofenceRadiusM: bad }, current).geofenceRadiusM, 400, `${JSON.stringify(bad)}`);
  }
  assert.equal(merge({ geofenceRadiusM: 150 }, current).geofenceRadiusM, 150);
  assert.equal(merge({ geofenceRadiusM: 9e9 }, current).geofenceRadiusM, MAX_RADIUS_METRES, "capped");
});

test("every new field is in the allowlist that leaves the building", () => {
  // SETTING_FIELDS is derived from DEFAULTS, so this is really asserting that the field
  // was added to DEFAULTS rather than only to merge() — which would produce a setting a
  // college could save and never see again.
  for (const key of ["networkCheck", "allowedNetworks", "geofenceCheck", "geofenceRadiusM"]) {
    assert.ok(SETTING_FIELDS.includes(key), `${key} is missing from SETTING_FIELDS`);
  }
});
