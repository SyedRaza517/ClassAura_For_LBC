// Tests for the conduct vocabulary resolver — the configurable behaviour/merit
// entries a lecturer taps in class.
//
// The dangerous failures here are the silent ones, same as the band config this
// pattern copies: a vocabulary that validates wrongly does not crash, it either
// offers a lecturer a button that writes nonsense points against a student, or
// switches a student notification on for a college that never chose it. So the
// tests are weighted toward refusals, and the two boolean fields are asserted
// strict — Boolean("false") is true, and a form that stringifies its fields must
// not flip "tell the student" on by accident.
//
// Run with: node --test   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULT_VOCABULARY, normaliseVocabulary } = require("./conductConfig");

const entry = (patch = {}) => ({
  key: "merit", label: "Merit", points: 1, tone: "positive",
  notifyStudent: false, active: true, ...patch,
});

test("the platform defaults are themselves a valid vocabulary", () => {
  const r = normaliseVocabulary(DEFAULT_VOCABULARY);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.vocabulary, DEFAULT_VOCABULARY);
});

test("the defaults notify nobody — telling students is a college's choice, not a default", () => {
  assert.ok(DEFAULT_VOCABULARY.length > 0);
  assert.ok(DEFAULT_VOCABULARY.every((e) => e.notifyStudent === false));
});

test("an empty list is refused — a college with no vocabulary has switched the feature off wrongly", () => {
  assert.equal(normaliseVocabulary([]).ok, false);
  assert.equal(normaliseVocabulary("nonsense").ok, false);
});

test("a duplicate key is refused, and the error names it", () => {
  const r = normaliseVocabulary([entry(), entry({ label: "Second Merit" })]);
  assert.equal(r.ok, false);
  assert.match(r.error, /merit/);
});

test("a key that is not a stable slug is refused — it is the handle events freeze against", () => {
  for (const key of ["", "Has Spaces", "UPPER", "x".repeat(41)]) {
    const r = normaliseVocabulary([entry({ key })]);
    assert.equal(r.ok, false, `key ${JSON.stringify(key)} was accepted`);
  }
});

test("points must be a whole number whose sign matches the tone", () => {
  // A positive entry scoring -1 is a config error a lecturer cannot see at tap time.
  assert.equal(normaliseVocabulary([entry({ points: -1 })]).ok, false, "positive with -1");
  assert.equal(normaliseVocabulary([entry({ tone: "negative", points: 1 })]).ok, false, "negative with +1");
  // Zero scores nothing: a conduct event that moves no points is a note, and PAT is
  // the notes feature.
  assert.equal(normaliseVocabulary([entry({ points: 0 })]).ok, false, "zero");
  assert.equal(normaliseVocabulary([entry({ points: 1.5 })]).ok, false, "fraction");
  assert.equal(normaliseVocabulary([entry({ points: 11 })]).ok, false, "beyond the cap");
  assert.equal(normaliseVocabulary([entry({ tone: "negative", points: -3 })]).ok, true);
});

test("tone is a closed vocabulary", () => {
  assert.equal(normaliseVocabulary([entry({ tone: "neutral" })]).ok, false);
});

test("notifyStudent and active are strict booleans, never coerced", () => {
  assert.equal(normaliseVocabulary([entry({ notifyStudent: "false" })]).ok, false);
  assert.equal(normaliseVocabulary([entry({ active: 1 })]).ok, false);
});

test("a vocabulary whose every entry is inactive is refused — the sheet would offer nothing", () => {
  const r = normaliseVocabulary([entry({ active: false })]);
  assert.equal(r.ok, false);
});

test("unknown fields are dropped, not stored — the allowlist is the shape", () => {
  const r = normaliseVocabulary([entry({ internalNote: "should never ship" })]);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(Object.keys(r.vocabulary[0]).sort(),
    ["active", "key", "label", "notifyStudent", "points", "tone"]);
});
