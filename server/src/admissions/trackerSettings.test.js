// Tests for the Admission Tracker's single-row configuration.
//
// The shape is the one CLAUDE.md documents for every config table here: platform
// defaults in code → one JSON column merged over them → no row until the college edits
// something → an allowlist on the way out. These tests cover the merge and the
// allowlist; the "one row" half is the database's job (a constant primary key) and is
// asserted in the smoke suite instead.
//
// Run with: node --test src/admissions/trackerSettings.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULTS, merge, targetsFor } = require("./trackerSettings");
const { DOC_KEYS } = require("../admissionDocs");

/* -------------------------------------------------------------------------- */
/* merge — a college with no stored row runs on the defaults                  */
/* -------------------------------------------------------------------------- */

test("a college that has never saved gets every document type required", () => {
  // The default must be the STRICTEST reading. A college that has not told us which
  // documents it demands has not told us it demands fewer.
  assert.deepEqual(merge(null).requiredDocTypes, DOC_KEYS);
});

test("a college that has never saved has no targets at all", () => {
  const t = merge(null).targets.default;
  // null, not 0. A target of zero is a target that everything beats.
  assert.equal(t.applications, null);
  assert.equal(t.enrolled, null);
  assert.equal(t.admitRate, null);
});

test("a stored value overrides only the field it names", () => {
  const c = merge({ targets: { default: { applications: 1200 } } });
  assert.equal(c.targets.default.applications, 1200);
  assert.equal(c.targets.default.enrolled, null);          // untouched
  assert.deepEqual(c.requiredDocTypes, DOC_KEYS);          // untouched
});

test("does not mutate the defaults between calls", () => {
  // A merge that wrote through to DEFAULTS would leak one call's targets into the
  // next, which in a long-lived server process means one save changing every read.
  merge({ targets: { default: { applications: 999 } } });
  assert.equal(merge(null).targets.default.applications, null);
});

/* -------------------------------------------------------------------------- */
/* merge — the allowlist, and refusing to coerce nonsense                     */
/* -------------------------------------------------------------------------- */

test("drops document types that are not real doc types", () => {
  const c = merge({ requiredDocTypes: ["passport", "unicorn", "ni"] });
  assert.deepEqual(c.requiredDocTypes, ["passport", "ni"]);
});

test("falls back to the defaults when the stored required list is empty", () => {
  // "This college requires no documents at all" is not a real admissions policy,
  // whereas a bad save writing [] is a real failure mode — and after the fact the two
  // are indistinguishable. The difference matters because an empty required set makes
  // every applicant "documents complete", silently inflating a funnel stage.
  assert.deepEqual(merge({ requiredDocTypes: [] }).requiredDocTypes, DOC_KEYS);
});

test("rejects a target that is not a usable number rather than coercing it", () => {
  const c = merge({ targets: { default: { applications: "lots", enrolled: -5, admitRate: NaN } } });
  assert.equal(c.targets.default.applications, null);
  assert.equal(c.targets.default.enrolled, null);   // a negative target is nonsense
  assert.equal(c.targets.default.admitRate, null);
});

test("keeps a target of zero, which is a real if unusual target", () => {
  assert.equal(merge({ targets: { default: { enrolled: 0 } } }).targets.default.enrolled, 0);
});

test("survives a stored blob of the wrong shape entirely", () => {
  // The column is JSON and nothing stops a bad migration or a hand-edit putting a
  // string, an array or null in it. Serving defaults beats throwing on every read.
  for (const junk of ["nope", 42, [], true, undefined]) {
    assert.deepEqual(merge(junk).requiredDocTypes, DOC_KEYS);
  }
});

/* -------------------------------------------------------------------------- */
/* targetsFor — per-intake overrides                                          */
/* -------------------------------------------------------------------------- */

test("an intake with no overrides gets the default targets", () => {
  const c = merge({ targets: { default: { applications: 1200 } } });
  assert.equal(targetsFor(c, "September 2026").applications, 1200);
});

test("an intake override replaces only the fields it names", () => {
  const c = merge({
    targets: { default: { applications: 1200, enrolled: 500 }, byIntake: { "September 2026": { applications: 1500 } } },
  });
  const t = targetsFor(c, "September 2026");
  assert.equal(t.applications, 1500);   // overridden
  assert.equal(t.enrolled, 500);        // inherited from the default
});

test("one intake's override does not reach another intake", () => {
  const c = merge({ targets: { default: { applications: 1200 }, byIntake: { "September 2026": { applications: 1500 } } } });
  assert.equal(targetsFor(c, "January 2027").applications, 1200);
});

test("no intake selected falls back to the default targets", () => {
  // The dashboard opens with every intake in scope; comparing that combined figure
  // against ONE intake's target would be measuring against the wrong denominator.
  const c = merge({ targets: { default: { applications: 1200 }, byIntake: { "September 2026": { applications: 1500 } } } });
  assert.equal(targetsFor(c, null).applications, 1200);
});

test("exposes DEFAULTS as the shape callers can rely on", () => {
  assert.ok(Array.isArray(DEFAULTS.requiredDocTypes));
  assert.ok("applications" in DEFAULTS.targets.default);
});
