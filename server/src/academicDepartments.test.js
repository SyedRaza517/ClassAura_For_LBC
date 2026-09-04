// The pure half of academicDepartments.js: what a college is allowed to store as its
// academic organisation chart.
//
// No database. Requiring the module constructs the shared Prisma client but issues no
// query, and nothing below reaches all(), active() or byKey().
//
// Run with: node --test src/academicDepartments.test.js   (from server/)
//
// WHY THE KEY RULES ARE LOAD-BEARING. Unlike a support-department key, this key is not
// stored on every row — Course and Student carry the department's cuid id. But the key
// IS what a saved filter, a URL fragment and the VLE mapping screen carry, and it can
// never be edited afterwards without orphaning them. So this function is the only place
// a bad key can be stopped.
const test = require("node:test");
const assert = require("node:assert/strict");

const { cleanOne, cleanList, KEY_RE } = require("./academicDepartments");

/* -------------------------------------------------------------------------- */
/* KEY_RE — what a slug may be                                                 */
/* -------------------------------------------------------------------------- */

test("KEY_RE accepts lower case, digits and hyphens, and nothing else", () => {
  for (const good of ["business", "computing", "health-social-care", "a", "law2", "a".repeat(40)]) {
    assert.equal(KEY_RE.test(good), true, `${good} should be a valid key`);
  }
});

test("KEY_RE rejects a key with a space, capitals, or over 40 characters", () => {
  // The key travels in a URL fragment and a query string. One that needs escaping would
  // work in the browser that created it and break in the next one to read it.
  for (const bad of ["health social care", "Business", "", "a".repeat(41), "law!"]) {
    assert.equal(KEY_RE.test(bad), false, `${bad} should be rejected`);
  }
});

/* -------------------------------------------------------------------------- */
/* cleanOne — one submitted department                                         */
/* -------------------------------------------------------------------------- */

test("cleanOne is an allowlist — an unknown field is dropped, not stored", () => {
  // A blocklist ships every column added afterwards to the browser by default. This is
  // the sAdmission lesson, applied before there is anything to leak.
  const out = cleanOne({ key: "business", name: "Business", colour: "#112233", active: true, secret: "x", id: "y" });
  assert.deepEqual(Object.keys(out).sort(), ["active", "colour", "key", "name"]);
});

test("cleanOne defaults active to true and only false switches it off", () => {
  assert.equal(cleanOne({ key: "law", name: "Law" }).active, true);
  assert.equal(cleanOne({ key: "law", name: "Law", active: false }).active, false);
  // A truthy non-boolean must not be read as "retired".
  assert.equal(cleanOne({ key: "law", name: "Law", active: 0 }).active, true);
});

test("cleanOne rejects a row whose key cannot be normalised, or which has no name", () => {
  // Note what is NOT here: a capitalised key. cleanOne lowercases BEFORE validating, so
  // "Business" is normalised to "business" rather than refused — matching
  // supportDepartments.cleanOne exactly. KEY_RE rejecting capitals (asserted above) and
  // cleanOne accepting them are both true, and the order of the two operations is the
  // whole reason. What cannot be rescued by lowercasing is still refused.
  assert.equal(cleanOne({ key: "bad key", name: "Business" }), null);
  assert.equal(cleanOne({ key: "law!", name: "Law" }), null);
  assert.equal(cleanOne({ key: "a".repeat(41), name: "Long" }), null);
  assert.equal(cleanOne({ key: "business", name: "   " }), null);
  assert.equal(cleanOne(null), null);
});

test("cleanOne lowercases the key and trims and caps the name", () => {
  assert.equal(cleanOne({ key: "  BUSINESS  ", name: "  Business  " }).key, "business");
  assert.equal(cleanOne({ key: "business", name: "x".repeat(200) }).name.length, 60);
});

test("cleanOne falls back to the platform colour when none is given or it is malformed", () => {
  // The colour is rendered straight into a style attribute. Anything that is not a
  // six-digit hex is replaced rather than escaped, because a value that needs escaping
  // is a value that will eventually be rendered somewhere that forgets to.
  assert.equal(cleanOne({ key: "law", name: "Law" }).colour, "#1a3a8f");
  assert.equal(cleanOne({ key: "law", name: "Law", colour: "red" }).colour, "#1a3a8f");
  assert.equal(cleanOne({ key: "law", name: "Law", colour: "#ABCDEF" }).colour, "#abcdef");
});

/* -------------------------------------------------------------------------- */
/* cleanList — a whole submitted list                                          */
/* -------------------------------------------------------------------------- */

test("cleanList collapses duplicate keys to the FIRST occurrence", () => {
  // Two departments sharing a key make one unreachable: the mapping screen, the saved
  // filter and every membership check match on the key alone.
  const out = cleanList([
    { key: "business", name: "Business" },
    { key: "business", name: "Business Studies" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Business");
});

test("cleanList drops invalid rows rather than rejecting the whole submission", () => {
  // An administrator editing eight departments should not lose seven edits to one typo.
  const out = cleanList([{ key: "business", name: "Business" }, { key: "BAD KEY", name: "x" }]);
  assert.deepEqual(out.map((d) => d.key), ["business"]);
});

test("cleanList returns null for a non-array, and caps the list at 50", () => {
  assert.equal(cleanList("business"), null);
  assert.equal(cleanList(null), null);
  const many = Array.from({ length: 80 }, (_, i) => ({ key: `d${i}`, name: `D${i}` }));
  assert.equal(cleanList(many).length, 50);
});
